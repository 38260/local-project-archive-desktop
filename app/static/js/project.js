/* 项目详情页：元信息、笔记编辑、README 渲染、目录树、快捷操作 */
(function () {
  "use strict";
  const { createApp } = Vue;

  const DRAFT_PREFIX = "lpa-draft-desc-";
  // 描述预览防抖定时器（非响应式，放组件外即可）
  let descTimer = null;

  // 递归目录树组件
  // 文件节点交互：单击复制相对路径，双击在应用内打开（.md / .txt）。
  // 浏览器在 dblclick 之前必定先派发两次 click，若不做区分就会「打开前先复制一次」，
  // 因此单击延迟一小段再执行、双击到来时取消它。延迟取 300ms：比系统双击间隔略短，
  // 单击手感可接受；极慢的双击最多多出一次复制（无副作用）。
  const TreeNode = {
    name: "tree-node",
    props: {
      node: { type: Object, required: true },
    },
    inject: ["openProjectFile"],
    data() {
      // 目录一律默认收起；展开状态记在 node.open 上，父目录收起再展开也能恢复
      return { open: !!(this.node && this.node.open) };
    },
    computed: {
      isDir() { return this.node.type === "dir"; },
      // 文件相对路径：后端 rel 为父目录，需拼上文件名
      fileRel() {
        if (this.node.type === "dir") return this.node.rel || this.node.name;
        const base = this.node.rel || "";
        return base ? `${base}/${this.node.name}` : this.node.name;
      },
      // 可在应用内打开的类型（当前支持 Markdown 与纯文本）
      canOpen() {
        return !this.isDir && /\.(md|markdown|txt)$/i.test(this.node.name || "");
      },
      fileTitle() {
        return this.canOpen
          ? `单击复制路径，双击打开：${this.fileRel}`
          : `单击复制路径：${this.fileRel}`;
      },
    },
    methods: {
      onClickFile() {
        if (this._clickTimer) clearTimeout(this._clickTimer);
        this._clickTimer = setTimeout(() => {
          this._clickTimer = null;
          copyText(this.fileRel);
        }, 300);
      },
      onDblClickFile() {
        if (this._clickTimer) {              // 双击：撤销待执行的单击复制
          clearTimeout(this._clickTimer);
          this._clickTimer = null;
        }
        if (!this.canOpen) {
          toast("当前仅 .md / .txt 支持在应用内打开，已复制该文件路径", "error");
          copyText(this.fileRel);
          return;
        }
        if (this.openProjectFile) this.openProjectFile(this.fileRel);
      },
    },
    beforeUnmount() {
      // 目录树重新加载会批量销毁节点，定时器必须清掉
      if (this._clickTimer) { clearTimeout(this._clickTimer); this._clickTimer = null; }
    },
    template: `
      <li class="t-row" :class="{ 't-file': !isDir, clickable: !isDir, openable: canOpen }">
        <template v-if="isDir">
          <span class="t-dir" @click="open = !open; node.open = open">
            <span class="t-caret">
              <svg class="licon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="open ? 'm6 9 6 6 6-6' : 'm9 18 6-6-6-6'"/></svg>
            </span>
            <lpa-icon :name="open ? 'folder-open' : 'folder'" :size="14"></lpa-icon>
            <span class="t-name">{{ node.name }}</span>
          </span>
          <span class="t-err" v-if="node.error">（{{ node.error }}）</span>
          <ul v-if="open">
            <tree-node v-for="c in node.children" :key="c.name" :node="c"></tree-node>
          </ul>
        </template>
        <template v-else>
          <span class="t-caret"></span>
          <span class="f-dot" :style="{ background: fileColor(node.name) }"></span>
          <span class="t-name" :style="{ color: fileColor(node.name) }"
                :title="fileTitle"
                @click="onClickFile"
                @dblclick="onDblClickFile">{{ node.name }}</span>
          <span class="t-size">{{ fmtSize(node.size) }}</span>
        </template>
      </li>
    `,
  };

  const app = createApp({
    data() {
      return {
        projectId: Number(location.pathname.split("/").pop()),
        p: null,
        statuses: [],
        meta: null,
        readme: null,
        tree: undefined, // undefined=加载中, null=失败
        notFound: false,
        themeTick: 0,
        // 相邻项目（详情页左右切换）
        siblings: [],
        // 描述编辑：脏标记 + 本地草稿
        descBaseline: "",
        descDraftRestored: false,
        savingDesc: false,
        // 其他
        rescanning: false,
        showEdit: false,
        savingEdit: false,
        editForm: {},
        newPath: "",
        // 开发笔记（多条）
        notes: [],
        noteDraft: null,          // null=收起编辑器，否则为草稿内容
        editingNoteId: null,
        editingNoteContent: "",
        // 变更日志
        changelogs: [],
        logDraft: null,
        logDraftTitle: "",
        logDraftDate: "",
        editingLogId: null,
        editLogForm: { title: "", content: "", entry_date: "" },
        // Git 提交记录
        commitData: null,
        commitLoading: true,
        commitLoadingMore: false,
        commitLimit: 50,        // 初始加载量，被设置 commits.limit 覆盖
        commitTypeFilter: "",
        expandedCommits: [],
        // 提交构成分析（GET /commit-stats）：全量分类计数 + 类型×月份。
        // 与 commitData 是**两个范围**：那个是最近 N 条明细（时间线），这个是全量聚合。
        commitStats: null,
        commitStatsLoading: true,
        // 按月提交柱状图：后端 /heatmap 固定取一年按天数据，前端聚合到日历月
        heat: null,
        monthSpan: 12,          // 柱状图月数（6=半年 | 12=一年），被设置 ui.heatmap_weeks 覆盖
        // 月柱状图默认折叠：它与下方「提交构成分析」里的类型×月份堆叠柱信息重叠，
        // 折叠后仍保留"共 N 次提交"的摘要可见，需要细节再展开。状态记忆在 localStorage，
        // 判据写成 `!== "0"`（即默认折叠），用户展开过一次后才记住"展开"。
        monthCollapsed: localStorage.getItem("lpa-month-collapsed") !== "0",
        editorCmd: "code",      // 打开项目的编辑器命令，被设置 editor.command 覆盖
        // 快速启动（GET /launch 载荷：note/note_html/supported/detect_kind/suggestions/launchers）
        launch: null,
        launchLoading: false,
        launchConfirm: true,    // 启动前确认，被设置 launch.confirm 覆盖
        launchNoteEditing: false,
        launchNoteDraft: "",
        launchNoteSaving: false,
        showLaunchForm: false,
        launchFormSaving: false,
        launchBusyKey: null,    // 启动中防连点
        launchForm: { id: null, name: "", command: "", cwd: "", mode: "console" },
        // 捕获运行与运行历史：勾选后后台执行并采集输出/退出码（记忆上次选择）
        runCapture: localStorage.getItem("lpa-run-capture") === "1",
        runs: [],               // 运行历史列表（不含输出正文）
        runsLoading: false,
        runOpenId: null,        // 当前展开输出查看的运行 id
        runDetail: null,        // 展开运行的详情（状态/退出码/耗时）
        runLines: [],           // 已拉取到的输出行
        runOffset: 0,           // 已拉取行数（增量轮询用）
        runStopping: false,
        // 截图
        screenshots: [],
        previewShot: null,
        uploadingShots: false,
        uploadCount: 0,
        shotsDrag: false,
        // 更多菜单 / 描述实时预览
        moreOpen: false,
        descLive: "",
        // 目录树收起状态（记忆在 localStorage，默认展开）
        treeCollapsed: localStorage.getItem("lpa-tree-collapsed") === "1",
        // 左侧锚点目录（sections 已改为计算属性，空面板自动隐藏）
        activeSection: "sec-info",
        spySuspendedUntil: 0,
        // 目录树分组的折叠状态（记忆在 localStorage，默认全部展开）
        tocCollapsed: (() => {
          try { return JSON.parse(localStorage.getItem("lpa-toc-collapsed") || "[]"); }
          catch (e) { return []; }
        })(),
        // 应用内文档查看器（README/笔记里的相对链接不再整页跳转，改在这里打开）
        docView: null,        // null=关闭；打开时为 {kind,name,rel,relDir,html,text,url,error?}
        docLoading: false,
      };
    },
    // 目录树是递归组件，用 provide 把「打开项目内文件」下发给任意层级的节点
    provide() {
      return { openProjectFile: rel => this.openProjectFile(rel) };
    },
    computed: {
      gitInfo() {
        return (this.meta && this.meta.git) || { is_repo: false };
      },
      themeIcon() {
        this.themeTick;
        const pref = window.themePref();
        return pref === "auto" ? "monitor" : (pref === "dark" ? "moon" : "sun");
      },
      themeLabel() {
        this.themeTick;
        return window.themeName();
      },
      descDirty() {
        return ((this.p && this.p.description) || "") !== this.descBaseline;
      },
      hasDescDraft() { return this.descDraftRestored; },
      prevProject() {
        const i = this.siblings.findIndex(s => s.id === this.projectId);
        return i > 0 ? this.siblings[i - 1] : null;
      },
      nextProject() {
        const i = this.siblings.findIndex(s => s.id === this.projectId);
        return (i >= 0 && i < this.siblings.length - 1) ? this.siblings[i + 1] : null;
      },
      // 头部数据徽章
      headBadges() {
        const m = this.meta || {};
        const b = [];
        if (this.gitInfo.is_repo) {
          b.push({ icon: "commit", label: "提交", val: this.fmtNum(this.gitInfo.commit_count) });
        }
        if (m.stats) {
          b.push({ icon: "files", label: "文件", val: this.fmtNum(m.stats.file_count) });
          b.push({ icon: "drive", label: "体积", val: this.fmtSize(m.stats.total_size) });
        }
        const langs = (this.p && this.p.tags || []).filter(t => this.tagClass(t) === "tag tag-lang")
          .slice(0, 2).join(" / ");
        if (langs) b.push({ icon: "layers", label: "语言", val: langs });
        return b;
      },
      // 按月提交柱状图：把 /heatmap 的按天计数聚合到最近 N 个日历月（旧 → 新）
      // 后端固定返回一年数据，足以覆盖 12 个完整日历月；跨度由设置（半年/一年）决定
      monthBars() {
        if (!this.heat || !this.heat.is_repo || !this.heat.days) return [];
        const days = this.heat.days;
        const now = new Date();
        const n = this.monthSpan === 6 ? 6 : 12;
        // 按月遍历计数：把每天的键归到 YYYY-MM，避免逐月扫全表
        const byMonth = {};
        for (const [day, count] of Object.entries(days)) {
          const key = day.slice(0, 7);
          byMonth[key] = (byMonth[key] || 0) + count;
        }
        const cur = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
        const bars = [];
        for (let i = n - 1; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
          const count = byMonth[key] || 0;
          bars.push({
            key, count,
            label: d.getMonth() + 1 + "月",
            tip: `${d.getFullYear()}年${d.getMonth() + 1}月：${count} 次提交`,
            current: key === cur,
          });
        }
        const max = Math.max(...bars.map(b => b.count), 1);
        for (const b of bars) b.pct = Math.round((b.count / max) * 100);
        return bars;
      },
      monthTotal() {
        return this.monthBars.reduce((s, m) => s + m.count, 0);
      },
      monthChartLabel() {
        return `${this.monthSpan === 6 ? "最近半年" : "最近一年"}按月提交柱状图，共 ${this.monthTotal} 次提交`;
      },
      // ---- 提交构成分析（全量口径，数据来自 /commit-stats）----
      // 类型分布行：条形宽度按「占最大类型」的比例，便于同屏比其他类型的量级
      statsRows() {
        const st = this.commitStats;
        if (!st || !st.is_repo || !st.types || !st.types.length) return [];
        const max = Math.max(...st.types.map(t => t.count), 1);
        return st.types.map(t => ({
          type: t.type, count: t.count, pct: t.pct,
          w: Math.max(Math.round((t.count / max) * 100), 2),
        }));
      },
      // 类型 × 月份堆叠柱：每段高度按「全月最大值」同一比例尺换算（count / max * 100），
      // 而不是按本柱占比——这样段高与整柱高出于同一把尺子，跨月份也能直接比长短，
      // 且不会因逐段四舍五入在柱内留缝。
      statsMonthBars() {
        const st = this.commitStats;
        if (!st || !st.is_repo || !st.months || !st.months.length) return [];
        const max = Math.max(...st.months.map(m => m.total), 1);
        const now = new Date();
        const cur = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
        const order = st.type_order || [];
        return st.months.map(m => ({
          key: m.key,
          label: Number(m.key.slice(5)) + "月",
          total: m.total,
          tip: `${m.key}：${m.total} 次提交`,
          current: m.key === cur,
          segs: order.filter(t => m.types[t]).map(t => ({
            type: t,
            count: m.types[t],
            h: (m.types[t] / max) * 100,
            title: `${t}：${m.types[t]} 次`,
          })),
        }));
      },
      statsChartLabel() {
        const st = this.commitStats;
        if (!st || !st.is_repo) return "";
        return `类型×月份堆叠柱状图，${st.months.length} 个月共 ${st.scanned} 次提交`;
      },
      // 环状图数据：按周长比例把每个类型切成一段（标准 stroke-dasharray 画法）。
      // 段长用**原始浮点**累加，保证各段首尾相接、环严丝合缝；只有"可见性下限"
      // 与"段间留缝"是刻意做的手脚（见 segLen / gap）。
      statsRing() {
        const rows = this.statsRows;
        const R = 42;                       // viewBox 100×100，留 8 单位给描边宽度
        const C = 2 * Math.PI * R;
        const total = rows.reduce((s, r) => s + r.count, 0);
        const n = rows.length;
        // 段间留 1.5 单位的缝：本项目有多个类型共用同一灰度（chore/other 等），
        // 不留缝时相邻同色段会连成一片，看不出分界。
        const gap = n > 1 ? 1.5 : 0;
        let acc = 0;
        const segs = rows.map(r => {
          const raw = total ? (r.count / total) * C : 0;
          // 段长 = 真实弧长 - 缝宽，并给一个 0.6 单位的下限：占比 <1% 的段按真实弧长
          // 会细到看不见（264 单位周长里 1% 才 2.6 单位），0.6 是"还能看见"的最小值。
          // 下限只在极小段上生效，此时累计偏移误差 <0.25% 圈长，肉眼不可辨。
          const segLen = Math.max(raw - gap, 0.6);
          const seg = {
            type: r.type, count: r.count, pct: r.pct,
            dash: +segLen.toFixed(3),
            rest: +(C - segLen).toFixed(3),
            offset: +(-acc).toFixed(3),
            title: `${r.type}：${r.count} 次（${r.pct}%）`,
          };
          acc += raw;
          return seg;
        });
        return { R, C: +C.toFixed(3), total, segs };
      },
      statsRingLabel() {
        const ring = this.statsRing;
        if (!ring.total) return "";
        const head = ring.segs.slice(0, 3)
          .map(s => `${s.type} ${s.pct}%`).join("、");
        return `提交类型分布环状图，共 ${ring.total} 次：${head}`;
      },
      // 口径标签：必须让用户看清"这是全量还是样本"（B7 不假装全量）
      statsScopeLabel() {
        const st = this.commitStats;
        if (!st || !st.is_repo) return "";
        const n = this.fmtNum(st.scanned);
        return st.truncated ? `基于最近 ${n} 次提交（已截断）` : `全量 ${n} 次提交`;
      },
      // 一句话结论：主要发力点 = 占比最高的类型 + 峰值月份 + 活跃天数
      statsConclusion() {
        const st = this.commitStats;
        if (!st || !st.is_repo || !st.types || !st.types.length) return "";
        const [top, second] = st.types;
        const parts = [`主要发力点：${top.type} ${top.pct}%`];
        if (second) parts.push(`${second.type} ${second.pct}%`);
        if (st.busiest_month) {
          const m = (st.months || []).find(x => x.key === st.busiest_month);
          parts.push(`峰值在 ${st.busiest_month}（${m ? m.total : 0} 次）`);
        }
        if (st.active_days) parts.push(`活跃 ${st.active_days} 天`);
        return parts.join(" · ");
      },
      statsFootnote() {
        const st = this.commitStats;
        if (!st || !st.is_repo) return "";
        return "口径：Conventional 前缀 + 未登记前缀按前缀名归类，无前缀者计入「其他」；"
          + "此处为提交次数，不等于工作量。";
      },
      // 关键词推断留痕（不参与分布，只在这里如实说明有多少条是猜的）
      statsWeakNote() {
        const st = this.commitStats;
        const w = (st && st.weak_inferred) || [];
        if (!w.length) return "";
        const sum = w.reduce((s, x) => s + x.count, 0);
        return `另有 ${sum} 条无前缀提交已计入「其他」（关键词推断倾向：`
          + w.slice(0, 3).map(x => `${x.type} ${x.count}`).join("、") + "）";
      },
      // 启动面板入口总数（自定义 + 去重后的自动检测）
      launchEntryCount() {
        if (!this.launch) return 0;
        return (this.launch.launchers || []).length + this.visibleSuggestions.length;
      },
      // 已转存为自定义启动项的建议不再重复展示（按 mode+cwd+command 去重）
      visibleSuggestions() {
        if (!this.launch) return [];
        const saved = new Set((this.launch.launchers || [])
          .map(l => `${l.mode}|${(l.cwd || "").trim()}|${l.command.trim()}`));
        return (this.launch.suggestions || [])
          .filter(s => !saved.has(`${s.mode}|${(s.cwd || "").trim()}|${s.command.trim()}`));
      },
      // 顶栏「启动」主按钮的默认入口：自定义优先，其次自动检测第一条
      primaryLaunchEntry() {
        if (!this.launch || !this.launch.supported) return null;
        return (this.launch.launchers && this.launch.launchers[0])
          || (this.visibleSuggestions && this.visibleSuggestions[0])
          || null;
      },
      // 有运行中的记录时，面板标题显示数量提示
      runningCount() {
        return (this.runs || []).filter(r => r.running).length;
      },
      // 左侧目录：隐藏空内容面板的锚点
      sections() {
        const list = [
          { id: "sec-info", label: "基础信息" },
          { id: "sec-git", label: "Git 信息", hide: !this.gitInfo.is_repo },
          { id: "sec-launch", label: "启动", hide: !!(this.p && this.p.is_lost) },
          { id: "sec-configs", label: "构建配置", hide: !(this.meta && this.meta.configs && this.meta.configs.length) },
          { id: "sec-stats", label: "文件统计", hide: false },
          { id: "sec-desc", label: "项目描述", hide: false },
          { id: "sec-notes", label: "开发笔记", hide: this.notes.length === 0 && this.noteDraft === null },
          { id: "sec-changelogs", label: "变更日志", hide: this.changelogs.length === 0 && this.logDraft === null },
          { id: "sec-commits", label: "提交记录", hide: !(this.commitData && this.commitData.is_repo && this.commitData.commits.length) },
          { id: "sec-shots", label: "截图", hide: false },
          { id: "sec-readme", label: "README", hide: !(this.readme && this.readme.exists) },
        ];
        return list.filter(x => !x.hide);
      },
      // 目录树分组：条目沿用 sections 的空面板过滤，空组整组隐藏
      sectionGroups() {
        const byId = {};
        for (const s of this.sections) byId[s.id] = s.label;
        const pick = ids => ids.filter(id => byId[id]).map(id => ({ id, label: byId[id] }));
        return [
          { id: "g-overview", icon: "folder", label: "概览",
            items: pick(["sec-info", "sec-git", "sec-launch"]) },
          { id: "g-build", icon: "package", label: "构建与统计",
            items: pick(["sec-configs", "sec-stats"]) },
          { id: "g-records", icon: "file-text", label: "内容记录",
            items: pick(["sec-desc", "sec-notes", "sec-changelogs", "sec-commits"]) },
          { id: "g-attach", icon: "image", label: "附件",
            items: pick(["sec-shots", "sec-readme"]) },
        ].filter(g => g.items.length);
      },
      // 依赖版本统计：固定(== / @精确版本) / 范围(^ ~ > <) / 未标注
      depStats() {
        const all = [];
        for (const c of (this.meta && this.meta.configs) || []) {
          for (const d of c.dependencies || []) all.push(d);
        }
        // Python 用 ==；Node 的 name@1.2.3（@ 后直接是数字）也视为固定
        const isPinned = d => d.includes("==") || /@\d/.test(d);
        const isRange = d => /[~^><=]/.test(d) && !isPinned(d);
        const pinnedList = all.filter(isPinned);
        const rangedList = all.filter(d => isRange(d));
        const unpinnedList = all.filter(d => !isPinned(d) && !isRange(d));
        return {
          total: all.length,
          pinned: pinnedList.length,
          ranged: rangedList.length,
          unpinned: unpinnedList.length,
          unpinnedList: unpinnedList.slice(0, 8),
        };
      },
      // 提交类型分布（用于时间线上方的筛选 chip）
      // 范围 = **已加载的时间线条目**：chips 本质是"筛下方列表"，
      // 所以它的数字必须等于点下去能筛出来的条数，不能取后端全量数字
      // （否则又变成"显示 43、点开只有 12"）。
      // 分类规则则与后端 /commit-stats 完全一致（commitType 认未登记前缀），
      // 所以 chips 的类型名与下方「提交构成分析」的类型名能一一对上；
      // 两者数字不同是**范围不同**（已加载 vs 全量），界面上分别标明。
      commitTypes() {
        if (!this.commitData || !this.commitData.commits.length) return [];
        const m = {};
        for (const c of this.commitData.commits) {
          const t = this.commitType(c.message) || "other";
          m[t] = (m[t] || 0) + 1;
        }
        return Object.keys(m)
          .sort((a, b) => m[b] - m[a])
          .map(t => ({ type: t, count: m[t] }));
      },
      visibleCommits() {
        if (!this.commitData || !this.commitData.commits) return [];
        if (!this.commitTypeFilter) return this.commitData.commits;
        return this.commitData.commits.filter(
          c => (this.commitType(c.message) || "other") === this.commitTypeFilter);
      },
      // 后端单次最多 200 条，据此判断是否还能加载更早提交
      hasMoreCommits() {
        return this.commitLimit < 200
          && !!this.commitData
          && this.commitData.commits.length < (this.commitData.total_count || 0);
      },
      // 扩展名占比条（基于 top_extensions）
      extBars() {
        const exts = (this.meta && this.meta.stats && this.meta.stats.top_extensions) || [];
        if (!exts.length) return [];
        const total = exts.reduce((s, row) => s + (row[1] || 0), 0) || 1;
        return exts.slice(0, 6).map(([ext, count]) => {
          const name = (ext && String(ext).startsWith(".")) ? `f${ext}` : "file";
          return {
            ext: ext || "(无扩展名)",
            count,
            pct: Math.max(1, Math.round((count / total) * 100)),
            color: this.fileColor(name),
          };
        });
      },
    },
    methods: {
      // 复制 README 原文（Markdown 源码）；正文本身可自由拖选复制
      async copyReadme() {
        if (this.readme && this.readme.raw) await this.copyText(this.readme.raw);
      },
      // ---- 引用文档：Markdown 里的链接统一在应用内处理，杜绝整页跳走白屏 ----
      // 事件委托捕获阶段拦截：只处理 Markdown 渲染区（.md-body）里的 <a>，
      // 其余站内链接（返回首页/上一项目/页面目录等）不受影响。
      onMdLinkClick(e) {
        const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
        if (!a) return;
        // 只接管 Markdown 内容里的链接（README/描述预览/笔记/日志/启动说明/文档查看器）
        const mdBox = a.closest(".md-body");
        if (!mdBox) return;
        const href = (a.getAttribute("href") || "").trim();
        if (!href || href.startsWith("#")) return;          // 页内锚点
        // 外部 http(s) 链接：交给系统默认浏览器，绝不把 WebView 窗口导航走
        if (/^(https?:)?\/\//i.test(href) || /^https?:/i.test(href)) {
          e.preventDefault();
          e.stopPropagation();
          this.openExternal(href);
          return;
        }
        // 应用内其它真实页面路径：照常跳转（如 README 里链接到另一项目详情）
        if (/^\/project\/\d+\/?$/.test(href) || href === "/") return;
        // 站内资源/接口（图片静态资源、导出等）让浏览器默认行为处理，不做项目文件解析
        if (/^\/(static|media|api)\//.test(href)) return;
        // 其余一律视为「本项目内的相对路径引用」：应用内查看器打开
        // （基准目录取自 Markdown 容器上的 data-relbase；查看器内嵌文档用它定位）
        e.preventDefault();
        e.stopPropagation();
        this.openReferencedFile(href, mdBox.dataset.relbase || "");
      },
      // 打开引用文件。baseDir：当前 Markdown 所在目录（页面 README/描述/笔记=项目根"",
      // 查看器内嵌文档=该文档的 relDir），相对链接依此解析。
      openReferencedFile(rawHref, baseDir) {
        baseDir = (baseDir || "").replace(/\/+$/, "");
        const rel = this.normalizeRel(
          baseDir ? baseDir + "/" + rawHref : rawHref);
        if (!rel) { toast("链接路径越出了项目范围，无法打开", "error"); return; }
        this.openDoc(rel);
      },
      // 规范化相对路径：去 ./ 前导、合并 ../，得到项目内相对路径
      normalizeRel(raw) {
        let s = String(raw || "").replace(/\\/g, "/").trim();
        if (/^[a-zA-Z]+:/i.test(s) || s.startsWith("//")) return "";  // 协议/盘符拒绝
        // markdown 作者可能写 URL 编码（%20 等），先解码再处理
        try { s = decodeURIComponent(s); } catch (e) { /* 原样使用 */ }
        // 去掉 #锚点 / ?query 与开头的 ./
        s = s.split(/[?#]/)[0].replace(/^(\.\/)+/, "");
        const segs = [];
        for (const p of s.split("/")) {
          if (!p || p === ".") continue;
          if (p === "..") { if (segs.length) segs.pop(); else return ""; }
          else segs.push(p);
        }
        return segs.join("/");
      },
      // 打开应用内文档查看器
      async openDoc(rel) {
        this.docLoading = true;
        this.docView = null;
        try {
          const d = await api(`/api/projects/${this.projectId}/file?rel=${encodeURIComponent(rel)}`,
            { silent: true });
          if (!d.found) { this.docView = { kind: "missing", rel }; return; }
          // relDir：该文档所在目录（查看器内的相对链接以此为基础解析）
          const i = rel.lastIndexOf("/");
          d.relDir = i > 0 ? rel.slice(0, i) : "";
          this.docView = d;
        } catch (err) {
          // 404/409/422 → 明确提示找不到原资源（不再白屏）
          this.docView = { kind: "missing", rel, error: err.message };
        } finally {
          this.docLoading = false;
        }
      },
      closeDoc() { this.docView = null; },
      // 目录树双击打开项目内文件：复用应用内文档查看器（.md 渲染 / .txt 纯文本）
      // 注意路径口径：目录树节点的 rel 以「项目文件夹名」为根（后端 build_tree
      // 把项目目录本身也当作根节点），而读取文件需要「项目内相对路径」，
      // 因此这里剥掉首段项目名；单击复制仍沿用节点原 rel，保持既有行为不变。
      openProjectFile(rel) {
        const clean = this.normalizeRel(rel);
        if (!clean) { toast("路径越出了项目范围，无法打开", "error"); return; }
        const root = (this.tree && this.tree.name) || "";
        let inner = clean;
        if (root && (clean === root || clean.startsWith(root + "/"))) {
          inner = clean.slice(root.length).replace(/^\/+/, "");
        }
        if (!inner) { toast("无法定位该文件在项目内的相对路径", "error"); return; }
        this.openDoc(inner);
      },
      // 外部 http(s) 链接 → 系统默认浏览器（后端校验仅 http/https）
      async openExternal(url) {
        try {
          await api("/api/open-url", { method: "POST", body: { url }, silent: true });
        } catch (err) {
          toast("无法打开外部浏览器：" + (err.message || ""), "error");
        }
      },
      // 查看器内嵌 Markdown 里相对链接的基准目录（数据绑定到模板 data-relbase）
      docRelBase() {
        if (!this.docView || this.docView.kind !== "md") return "";
        return this.docView.relDir || "";
      },
      async load() {
        try {
          const p = await api(`/api/projects/${this.projectId}`);
          this.p = p;
          this.statuses = p.statuses || [];
          this.meta = p.auto_meta || {};
          this.newPath = p.is_lost ? "" : p.path;
          this.syncDesc();
          this.restoreDescDraft();
          this.loadSiblings();
          this.loadReadme();
          this.loadTree();
          this.loadNotes();
          this.loadChangelogs();
          this.loadShots();
          this.loadLaunch();
          this.loadRuns();
          // 先拿设置（决定提交记录加载数），再加载提交与热力图
          await this.loadPrefs();
          this.loadCommits();
          // 与分析块并行发起、互不 await：两者数据源独立，
          // 分析块慢/失败都不该拖住时间线（反之亦然）
          this.loadCommitStats();
        } catch (e) {
          if (e.status === 404) this.notFound = true;
        }
      },
      // 读取通用设置：提交记录加载数 / 热力图范围（设置里改了立即生效于下次加载）
      async loadPrefs() {
        try {
          const s = await api("/api/settings", { silent: true });
          if (s) {
            if (s["commits.limit"]) this.commitLimit = Number(s["commits.limit"]) || 200;
            // 半年(26 周)=6 个月 / 一年(53 周)=12 个月
            this.monthSpan = Number(s["ui.heatmap_weeks"]) === 26 ? 6 : 12;
            this.editorCmd = s["editor.command"] || "code";
            this.launchConfirm = s["launch.confirm"] !== false;
          }
        } catch (e) { /* 设置读取失败不影响详情页 */ }
        this.loadHeatmap();
      },
      // ---- 设置（共享弹窗，见 js/settings.js；首页同款） ----
      openSettings() { this.$refs.settings.open(); },
      // 设置变更联动：prefs=编辑器命令/提交加载数/热力图范围随改随生效；
      // data=数据被恢复/清空，整页重载（load 自带 404 处理）
      onSettingsChanged(kind) {
        this.themeTick++;   // 主题可能被设置弹窗改过，顶栏按钮文字/图标需刷新
        if (kind === "data") { this.load(); return; }
        this.loadPrefs();
      },
      // ---- 快速启动（检测/说明/自定义项/执行） ----
      async loadLaunch() {
        if (this.p && this.p.is_lost) { this.launch = null; return; }
        this.launchLoading = true;
        try {
          this.launch = await api(`/api/projects/${this.projectId}/launch`, { silent: true });
        } catch (e) {
          this.launch = null;   // 检测失败不影响详情页其他面板
        } finally { this.launchLoading = false; }
      },
      // 执行一个入口：entry 带 id 走已保存启动项，否则按完整命令直跑（自动检测）
      // 确认框内可勾选「捕获输出并记录」：勾选后走后台捕获运行（可看退出码与日志），
      // 不勾选仍是原有的「新终端窗口运行」——输出属于那个控制台，父进程读不到。
      async runEntry(entry) {
        if (this.launchBusyKey) return;              // 正在启动中，忽略连点
        const modeText = entry.mode === "open" ? "直接运行" : "在新终端窗口运行";
        const cmdText = entry.command + (entry.cwd ? `\n子目录：${entry.cwd}` : "");
        // 「直接运行」由目标程序自己承载日志，无法采集输出，故不提供该选项
        const canCapture = entry.mode !== "open";
        let capture = canCapture && this.runCapture;
        if (this.launchConfirm) {
          const r = await confirmDialog(
            `将${modeText}：\n${cmdText}\n\n命令来自项目内文件，运行前请确认内容。`,
            { title: `启动 · ${entry.name}`, okText: "启动",
              checkbox: canCapture
                ? { label: "捕获输出并记录（后台运行，可查看退出码与日志）",
                    checked: this.runCapture }
                : undefined });
          if (!r) return;
          capture = !!(r && r.checked);
        }
        if (canCapture) {                            // 记住选择，下次默认沿用
          this.runCapture = capture;
          localStorage.setItem("lpa-run-capture", capture ? "1" : "0");
        }
        this.launchBusyKey = entry.id ? `l${entry.id}` : `s${entry.command}`;
        try {
          const body = entry.id
            ? { launcher_id: entry.id, capture }
            : { command: entry.command, name: entry.name,
                mode: entry.mode, cwd: entry.cwd || "", capture };
          const r = await api(`/api/projects/${this.projectId}/launch`,
            { method: "POST", body });
          toast(r.note || "已启动", "ok");
          if (r.run_id) {                            // 捕获运行：刷新历史并直接展开输出
            await this.loadRuns();
            await this.toggleRun({ id: r.run_id });
          }
        } catch (e) { /* toast 已提示 */ }
        finally { this.launchBusyKey = null; }
      },
      // ---- 运行历史（捕获运行） ----
      async loadRuns() {
        if (!this.p || this.p.is_lost) { this.runs = []; return; }
        this.runsLoading = true;
        try {
          const r = await api(`/api/projects/${this.projectId}/runs?limit=10`,
            { silent: true });
          this.runs = r.runs || [];
        } catch (e) { this.runs = []; }              // 历史读取失败不影响启动面板
        finally { this.runsLoading = false; }
      },
      runStatusMeta(run) {
        const map = {
          running: { text: "运行中", cls: "run-running" },
          succeeded: { text: "成功", cls: "run-ok" },
          failed: { text: "失败", cls: "run-fail" },
          stopped: { text: "已停止", cls: "run-stop" },
          error: { text: "启动失败", cls: "run-fail" },
        };
        return map[(run && run.status) || ""] || { text: (run && run.status) || "-", cls: "" };
      },
      runExitText(run) {
        if (!run) return "";
        if (run.running) return "退出码：运行中";
        return run.exit_code == null ? "退出码：未知" : `退出码：${run.exit_code}`;
      },
      async toggleRun(run) {
        if (this.runOpenId === run.id) { this.closeRun(); return; }
        this.runOpenId = run.id;
        this.runDetail = null;
        this.runLines = [];
        this.runOffset = 0;
        await this.pollRun(true);
      },
      closeRun() {
        this.stopRunPolling();
        this.runOpenId = null;
        this.runDetail = null;
        this.runLines = [];
        this.runOffset = 0;
      },
      stopRunPolling() {
        if (this._runTimer) { clearTimeout(this._runTimer); this._runTimer = null; }
      },
      // 拉取一次运行详情（增量取输出）；仍在运行时继续轮询直到结束
      async pollRun(initial) {
        if (!this.runOpenId) return;
        const rid = this.runOpenId;
        try {
          const r = await api(
            `/api/projects/${this.projectId}/runs/${rid}?offset=${this.runOffset}`,
            { silent: true });
          if (this.runOpenId !== rid) return;        // 已切换目标，丢弃本次结果
          this.runDetail = r.run;
          if (r.lines && r.lines.length) this.runLines = this.runLines.concat(r.lines);
          this.runOffset = r.offset;
          if (!r.run.running) {
            if (!initial) this.loadRuns();           // 结束：刷新列表让摘要与展开内容一致
            this.stopRunPolling();
          } else {
            this.scheduleRunPoll();
          }
        } catch (e) {
          this.stopRunPolling();                     // 记录可能已被清理，停止轮询
        }
      },
      scheduleRunPoll() {
        this.stopRunPolling();
        this._runTimer = setTimeout(() => this.pollRun(false), 1500);
      },
      async stopRun(run) {
        if (!await confirmDialog(
          `停止「${run.name || run.command}」？\n\n将结束该进程及其子进程（包括它占用的端口）。`,
          { title: "停止运行", okText: "停止", danger: true })) return;
        this.runStopping = true;
        try {
          const r = await api(`/api/projects/${this.projectId}/runs/${run.id}/stop`,
            { method: "POST" });
          toast(r.note || "已发送停止指令", "ok");
          // 进程退出需要一点时间，稍后再刷新状态
          setTimeout(() => {
            this.loadRuns();
            if (this.runOpenId === run.id) this.pollRun(false);
          }, 900);
        } catch (e) { /* toast 已提示 */ }
        finally { this.runStopping = false; }
      },
      async deleteRun(run) {
        try {
          await api(`/api/projects/${this.projectId}/runs/${run.id}`, { method: "DELETE" });
          if (this.runOpenId === run.id) this.closeRun();
          this.loadRuns();
          toast("运行记录已删除", "ok");
        } catch (e) { /* toast 已提示 */ }
      },
      async clearRuns() {
        if (!this.runs.length) return;
        if (!await confirmDialog(
          `清空本项目的 ${this.runs.length} 条运行记录？\n\n只删除记录，不影响项目文件与运行中的进程。`,
          { title: "清空运行历史", okText: "清空", danger: true })) return;
        try {
          const r = await api(`/api/projects/${this.projectId}/runs`, { method: "DELETE" });
          this.closeRun();
          this.loadRuns();
          toast(`已清空 ${r.removed} 条运行记录`, "ok");
        } catch (e) { /* toast 已提示 */ }
      },
      quickLaunch() {
        if (this.primaryLaunchEntry) this.runEntry(this.primaryLaunchEntry);
        else this.scrollTo("sec-launch");   // 没有明确入口时跳到启动面板自行选择
      },
      toggleLaunchNoteEdit() {
        this.launchNoteDraft = (this.launch && this.launch.note) || "";
        this.launchNoteEditing = true;
      },
      async saveLaunchNote() {
        this.launchNoteSaving = true;
        try {
          const r = await api(`/api/projects/${this.projectId}/launch-note`,
            { method: "PUT", body: { note: this.launchNoteDraft } });
          if (this.launch) { this.launch.note = r.note; this.launch.note_html = r.note_html; }
          this.launchNoteEditing = false;
          toast("启动说明已保存", "ok");
        } catch (e) { /* toast 已提示 */ }
        finally { this.launchNoteSaving = false; }
      },
      // 编辑弹窗：entry=已保存项；suggestion=自动检测建议（转存预填）
      openLaunchForm(entry, suggestion) {
        if (entry) {
          this.launchForm = { id: entry.id, name: entry.name, command: entry.command,
                              cwd: entry.cwd || "", mode: entry.mode || "console" };
        } else if (suggestion) {
          this.launchForm = { id: null, name: suggestion.name, command: suggestion.command,
                              cwd: suggestion.cwd || "", mode: suggestion.mode || "console" };
        } else {
          this.launchForm = { id: null, name: "", command: "", cwd: "", mode: "console" };
        }
        this.showLaunchForm = true;
      },
      async saveLaunchForm() {
        const f = this.launchForm;
        if (!f.name.trim()) { toast("请填写启动项名称", "error"); return; }
        if (!f.command.trim()) { toast("请填写启动命令", "error"); return; }
        this.launchFormSaving = true;
        try {
          const body = { name: f.name.trim(), command: f.command.trim(),
                         cwd: f.cwd.trim(), mode: f.mode };
          if (f.id) {
            await api(`/api/projects/${this.projectId}/launchers/${f.id}`,
              { method: "PUT", body });
          } else {
            await api(`/api/projects/${this.projectId}/launchers`, { method: "POST", body });
          }
          this.showLaunchForm = false;
          toast(f.id ? "启动项已更新" : "启动项已添加", "ok");
          this.loadLaunch();
        } catch (e) { /* toast 已提示 */ }
        finally { this.launchFormSaving = false; }
      },
      async deleteLauncher(l) {
        if (!await confirmDialog(`删除启动项「${l.name}」？`,
          { title: "删除启动项", okText: "删除", danger: true })) return;
        try {
          await api(`/api/projects/${this.projectId}/launchers/${l.id}`, { method: "DELETE" });
          toast("启动项已删除", "ok");
          this.loadLaunch();
        } catch (e) { /* toast 已提示 */ }
      },
      // 提交活动数据：固定取一年按天聚合（足以覆盖 12 个完整日历月），
      // 半年/一年视图由前端从同一份数据聚合，切换跨度不再重新请求
      async loadHeatmap() {
        try {
          this.heat = await api(
            `/api/projects/${this.projectId}/heatmap?weeks=53`, { silent: true });
        } catch (e) {
          this.heat = null;
        }
      },
      // 点击热力图某天：按日期取当天提交并在弹窗展示
      // 描述：同步基线（用于脏标记），并尝试恢复上次未保存草稿
      syncDesc() {
        this.descBaseline = (this.p && this.p.description) || "";
        this.descLive = (this.p && this.p.description_html) || "";
      },
      restoreDescDraft() {
        const saved = localStorage.getItem(DRAFT_PREFIX + this.projectId);
        if (saved != null && saved !== this.p.description) {
          this.p.description = saved;
          this.descDraftRestored = true;
          this.descLiveDebounce();
        }
      },
      onDescInput() {
        this.descLiveDebounce();
        // 有未保存改动时写入本地草稿，刷新/误关后可恢复
        if (this.descDirty) {
          localStorage.setItem(DRAFT_PREFIX + this.projectId, this.p.description || "");
        } else {
          localStorage.removeItem(DRAFT_PREFIX + this.projectId);
          this.descDraftRestored = false;
        }
      },
      clearDescDraft() {
        localStorage.removeItem(DRAFT_PREFIX + this.projectId);
        this.descDraftRestored = false;
      },
      async loadSiblings() {
        try {
          // 轻量接口：只取 id/name，不做磁盘校验
          const data = await api("/api/projects/brief", { silent: true });
          this.siblings = data.projects || [];
        } catch (e) { this.siblings = []; }
      },
      gotoSibling(target) { if (target) this.leaveConfirm("/project/" + target.id); },
      // 离开详情页的统一出口：有未保存草稿时先应用内确认，再跳转。
      // 不用原生 beforeunload——打包为 pywebview(WebView2) 后该原生确认框可能被宿主窗口
      // 盖住/失焦而不可见，用户点「返回首页」毫无反应，表现为「打开后退不出来」。
      // 描述草稿本身会落 localStorage（下次进入自动恢复），笔记/日志草稿离开即丢，
      // 提示文案如实区分，让用户自己决定。
      leaveConfirm(url) {
        const hasUnsaved = this.descDirty
          || (this.noteDraft != null && String(this.noteDraft).trim())
          || (this.logDraft != null && String(this.logDraft).trim());
        if (!hasUnsaved) { location.href = url; return; }
        confirmDialog(
          "当前页面有未保存的内容（描述、笔记或变更日志）。\n\n"
          + "描述草稿会自动保留，下次打开本项目可继续编辑；"
          + "尚未保存的笔记 / 日志离开后将丢失。",
          { title: "离开详情页", okText: "仍然离开" })
          .then(ok => { if (ok) location.href = url; });
      },
      switchTheme() { window.cycleTheme(); this.themeTick++; },
      // ---- 开发笔记 ----
      async loadNotes() {
        try {
          const r = await api(`/api/projects/${this.projectId}/notes`, { silent: true });
          this.notes = r.notes;
        } catch (e) { this.notes = []; }
      },
      async saveNewNote() {
        try {
          await api(`/api/projects/${this.projectId}/notes`, {
            method: "POST", body: { content: this.noteDraft },
          });
          this.noteDraft = null;
          toast("笔记已保存", "ok");
          this.loadNotes();
        } catch (e) { /* toast 已提示 */ }
      },
      startEditNote(n) {
        this.editingNoteId = n.id;
        this.editingNoteContent = n.content;
      },
      async saveEditNote(n) {
        try {
          await api(`/api/projects/${this.projectId}/notes/${n.id}`, {
            method: "PUT", body: { content: this.editingNoteContent },
          });
          this.editingNoteId = null;
          toast("笔记已更新", "ok");
          this.loadNotes();
        } catch (e) { /* toast 已提示 */ }
      },
      async deleteNote(n) {
        if (!await confirmDialog("确定删除这条笔记吗？删除后不可恢复。",
          { title: "删除笔记", okText: "删除", danger: true })) return;
        try {
          await api(`/api/projects/${this.projectId}/notes/${n.id}`, { method: "DELETE" });
          toast("笔记已删除", "ok");
          this.loadNotes();
        } catch (e) { /* toast 已提示 */ }
      },
      // ---- 变更日志 ----
      async loadChangelogs() {
        try {
          const r = await api(`/api/projects/${this.projectId}/changelogs`, { silent: true });
          this.changelogs = r.changelogs;
        } catch (e) { this.changelogs = []; }
      },
      openLogDraft() {
        this.logDraft = "";
        this.logDraftTitle = "";
        // 用本地年月日：toISOString() 取的是 UTC 日期，东八区凌晨会错成昨天
        const d = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        this.logDraftDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      },
      async saveNewLog() {
        try {
          await api(`/api/projects/${this.projectId}/changelogs`, {
            method: "POST",
            body: { title: this.logDraftTitle, content: this.logDraft, entry_date: this.logDraftDate },
          });
          this.logDraft = null;
          toast("变更日志已保存", "ok");
          this.loadChangelogs();
        } catch (e) { /* toast 已提示 */ }
      },
      startEditLog(c) {
        this.editingLogId = c.id;
        this.editLogForm = { title: c.title, content: c.content, entry_date: c.entry_date };
      },
      async saveEditLog(c) {
        try {
          await api(`/api/projects/${this.projectId}/changelogs/${c.id}`, {
            method: "PUT", body: this.editLogForm,
          });
          this.editingLogId = null;
          toast("变更日志已更新", "ok");
          this.loadChangelogs();
        } catch (e) { /* toast 已提示 */ }
      },
      async deleteLog(c) {
        if (!await confirmDialog(`确定删除变更日志「${c.title || "未命名条目"}」吗？`,
          { title: "删除变更日志", okText: "删除", danger: true })) return;
        try {
          await api(`/api/projects/${this.projectId}/changelogs/${c.id}`, { method: "DELETE" });
          toast("变更日志条目已删除", "ok");
          this.loadChangelogs();
        } catch (e) { /* toast 已提示 */ }
      },
      // ---- 项目截图 ----
      async loadShots() {
        try {
          const r = await api(`/api/projects/${this.projectId}/screenshots`, { silent: true });
          this.screenshots = r.screenshots;
        } catch (e) { this.screenshots = []; }
      },
      async uploadShots(e) {
        const files = [...(e.target.files || [])];
        if (!files.length) return;
        await this.postShots(files);
        e.target.value = "";
      },
      async dropShots(e) {
        this.shotsDrag = false;
        const files = [...(e.dataTransfer?.files || [])];
        if (!files.length) return;
        await this.postShots(files);
      },
      async postShots(files) {
        this.uploadingShots = true;
        this.uploadCount = files.length;
        try {
          const fd = new FormData();
          files.forEach(f => fd.append("files", f));
          const resp = await fetch(`/api/projects/${this.projectId}/screenshots`, {
            method: "POST", body: fd,
          });
          const r = await resp.json();
          if (!resp.ok) throw new Error(r.detail || "上传失败");
          let msg = `已保存 ${r.saved.length} 张截图`;
          if (r.errors.length) msg += `，${r.errors.length} 张失败（${r.errors[0].reason}）`;
          toast(msg, r.errors.length ? "error" : "ok");
          this.loadShots();
        } catch (err) {
          toast("截图上传失败：" + err.message, "error");
        } finally {
          this.uploadingShots = false;
          this.uploadCount = 0;
        }
      },
      async deleteShot(s) {
        if (!await confirmDialog("确定删除这张截图吗？",
          { title: "删除截图", okText: "删除", danger: true })) return;
        try {
          await api(`/api/projects/${this.projectId}/screenshots/${encodeURIComponent(s.file)}`,
                    { method: "DELETE" });
          toast("截图已删除", "ok");
          this.loadShots();
        } catch (e) { /* toast 已提示 */ }
      },
      // ---- 导出 HTML 档案 ----
      exportHtml() {
        // location.href 触发下载不会有页面反馈，先 toast 一声避免误以为没反应
        toast("正在生成导出文件…", "ok");
        location.href = `/api/projects/${this.projectId}/export-html`;
      },
      // ---- Markdown 工具栏：在光标处包裹/插入 ----
      mdWrap(refName, before, after) {
        const el = this.$refs[refName];
        if (!el) return;
        const s = el.selectionStart, e = el.selectionEnd;
        const v = el.value;
        el.value = v.slice(0, s) + before + v.slice(s, e) + after + v.slice(e);
        el.selectionStart = s + before.length;
        el.selectionEnd = e + before.length;
        el.focus();
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      // 描述实时预览（500ms 防抖）
      descLiveDebounce() {
        clearTimeout(descTimer);
        descTimer = setTimeout(async () => {
          try {
            const r = await api("/api/render-md", {
              method: "POST", body: { text: this.p.description || "", mode: "notes" }, silent: true,
            });
            this.descLive = r.html;
          } catch (e) { /* 静默 */ }
        }, 500);
      },
      // ---- Git 提交记录 ----
      // 提交构成分析：全量分类计数 + 类型×月份（后端只回计数，不回明细）
      // 失败时置 null，模板据此整块隐藏或显示降级文案，不影响时间线与其它面板
      async loadCommitStats() {
        this.commitStatsLoading = true;
        try {
          this.commitStats = await api(
            `/api/projects/${this.projectId}/commit-stats`, { silent: true });
        } catch (e) {
          this.commitStats = null;
        } finally {
          this.commitStatsLoading = false;
        }
      },
      async loadCommits(more) {
        if (more) this.commitLoadingMore = true;
        else this.commitLoading = true;
        if (!more) this.expandedCommits = [];
        try {
          this.commitData = await api(
            `/api/projects/${this.projectId}/commits?limit=${this.commitLimit}`, { silent: true });
        } catch (e) {
          this.commitData = null;
        } finally {
          this.commitLoading = false;
          this.commitLoadingMore = false;
        }
      },
      loadMoreCommits() {
        if (!this.hasMoreCommits) return;
        this.commitLimit = Math.min(this.commitLimit + 50, 200);
        this.loadCommits(true);
      },
      firstLine(msg) { return ((msg || "").split("\n")[0] || "").slice(0, 120); },
      toggleTree() {
        this.treeCollapsed = !this.treeCollapsed;
        localStorage.setItem("lpa-tree-collapsed", this.treeCollapsed ? "1" : "0");
      },
      // 月柱状图折叠（状态跨项目记忆）
      toggleMonthChart() {
        this.monthCollapsed = !this.monthCollapsed;
        localStorage.setItem("lpa-month-collapsed", this.monthCollapsed ? "1" : "0");
      },
      // 目录树分组折叠（跨项目记忆展开偏好）
      toggleGroup(id) {
        const i = this.tocCollapsed.indexOf(id);
        if (i >= 0) this.tocCollapsed.splice(i, 1);
        else this.tocCollapsed.push(id);
        localStorage.setItem("lpa-toc-collapsed", JSON.stringify(this.tocCollapsed));
      },
      toggleCommit(hash) {
        const i = this.expandedCommits.indexOf(hash);
        if (i >= 0) this.expandedCommits.splice(i, 1);
        else this.expandedCommits.push(hash);
      },
      // ---- 左侧锚点目录 ----
      scrollTo(id) {
        // 点击后锁定高亮，等平滑滚动结束再交还滚动监听，
        // 避免页面触底时（目标无法滚到顶部）高亮跳回上一个面板
        this.activeSection = id;
        this.spySuspendedUntil = Date.now() + 1000;
        const el = document.getElementById(id);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          el.classList.add("flash");
          setTimeout(() => el.classList.remove("flash"), 1200);
        }
      },
      // 滚动监听：高亮当前视口所在的面板
      onScroll() {
        if (Date.now() < (this.spySuspendedUntil || 0)) return;
        const offset = 90; // 与 sticky 顶栏高度对应
        let current = "";
        const secs = this.sections;
        if (!secs.length) return;
        for (const s of secs) {
          const el = document.getElementById(s.id);
          if (el && el.getBoundingClientRect().top <= offset) current = s.id;
        }
        this.activeSection = current || secs[0].id;
      },
      async loadReadme() {
        if (this.p.is_lost) { this.readme = { exists: false }; return; }
        try {
          this.readme = await api(`/api/projects/${this.projectId}/readme`, { silent: true });
        } catch (e) {
          this.readme = { exists: false };
        }
      },
      async loadTree() {
        if (this.p.is_lost) { this.tree = null; return; }
        try {
          this.tree = await api(`/api/projects/${this.projectId}/tree`, { silent: true });
        } catch (e) {
          this.tree = null;
        }
      },
      async saveStatus() {
        try {
          const p = await api(`/api/projects/${this.projectId}`, {
            method: "PUT", body: { status: this.p.status },
          });
          this.p.updated_at = p.updated_at;
          toast(`状态已更新为「${p.status}」`, "ok");
        } catch (e) { this.load(); }
      },
      async saveDesc() {
        this.savingDesc = true;
        try {
          await api(`/api/projects/${this.projectId}`, {
            method: "PUT", body: { description: this.p.description },
          });
          this.descBaseline = this.p.description || "";
          this.clearDescDraft();
          toast("描述已保存到本机数据库", "ok");
        } catch (e) { /* toast 已提示 */ }
        finally { this.savingDesc = false; }
      },
      async openIn(target) {
        try {
          await api(`/api/projects/${this.projectId}/open`, {
            method: "POST", body: { target },
          });
          toast(target === "vscode" ? "已在 VS Code 中打开" : "已在资源管理器中打开", "ok");
        } catch (e) { /* toast 已提示 */ }
      },
      async togglePin() {
        try {
          const r = await api(`/api/projects/${this.projectId}/pin`, { method: "POST" });
          this.p.pinned = r.pinned;
          toast(r.pinned ? "已置顶，列表中将优先展示" : "已取消置顶", "ok");
        } catch (e) { /* toast 已提示 */ }
      },
      // 重新解析后同步描述基线（保留用户未保存的草稿内容）
      reloadMeta(p) {
        this.p = p;
        this.meta = p.auto_meta || {};
        this.syncDesc();
        this.newPath = p.path;
      },
      async rescan() {
        this.rescanning = true;
        try {
          const r = await api(`/api/projects/${this.projectId}/rescan`, { method: "POST" });
          this.reloadMeta(r);
          if (r.parse_ok) {
            toast("重新解析完成", "ok");
            this.readme = null;
            this.tree = undefined;
            this.loadReadme();
            this.loadTree();
            this.loadCommits();
          } else {
            toast("路径已失效，项目被标记为丢失", "error");
          }
        } catch (e) { /* toast 已提示 */ }
        finally { this.rescanning = false; }
      },
      async updatePath() {
        if (!this.newPath) return;
        try {
          const p = await api(`/api/projects/${this.projectId}`, {
            method: "PUT", body: { path: this.newPath },
          });
          this.reloadMeta(p);
          toast("路径已更新并重新解析", "ok");
          this.readme = null;
          this.tree = undefined;
          this.loadReadme();
          this.loadTree();
          this.loadCommits();
        } catch (e) { /* toast 已提示 */ }
      },
      openEdit() {
        this.editForm = {
          path: this.p.path,
          name: this.p.name,
          alias: this.p.alias,
          category: this.p.category,
          status: this.p.status,
          tagsText: (this.p.tags || []).join(", "),
        };
        this.showEdit = true;
      },
      async saveEdit() {
        this.savingEdit = true;
        try {
          const p = await api(`/api/projects/${this.projectId}`, {
            method: "PUT",
            body: {
              path: this.editForm.path,
              name: this.editForm.name,
              alias: this.editForm.alias,
              category: this.editForm.category,
              status: this.editForm.status,
              tags: this.editForm.tagsText.split(/[,，;；]/).map(s => s.trim()).filter(Boolean),
            },
          });
          this.reloadMeta(p);
          this.showEdit = false;
          toast("档案信息已保存", "ok");
        } catch (e) { /* toast 已提示 */ }
        finally { this.savingEdit = false; }
      },
      // 灯箱左右切换（循环）
      navShot(dir) {
        const i = this.screenshots.indexOf(this.previewShot);
        if (i < 0) return;
        const n = this.screenshots.length;
        this.previewShot = this.screenshots[(i + dir + n) % n];
      },
      async removeProject() {
        if (!await confirmDialog(
          `确定删除「${this.p.name}」的档案记录吗？\n仅删除本系统中的索引数据，不会改动原项目文件夹的任何文件。`,
          { title: "删除档案", okText: "删除", danger: true })) return;
        try {
          await api(`/api/projects/${this.projectId}`, { method: "DELETE" });
          this.clearDescDraft();
          toast("档案记录已删除", "ok");
          setTimeout(() => { location.href = "/"; }, 600);
        } catch (e) { /* toast 已提示 */ }
      },
    },
    mounted() {
      this.load();
      window.addEventListener("scroll", this.onScroll, { passive: true });
      // 有未保存内容时的离开确认改用应用内弹窗（leaveConfirm），见 gotoSibling/返回首页：
      // 原生 beforeunload 在 pywebview(WebView2) 桌面壳里确认框可能不可见，导致「退不出来」。
      // Esc 依次关闭：文档查看器 → 设置弹窗 → 截图灯箱 → 启动表单 → 更多菜单 → 编辑弹窗
      this._onKey = (e) => {
        if (e.key !== "Escape") return;
        if (this.docView) { this.docView = null; return; }
        if (this.$refs.settings && this.$refs.settings.visible) { this.$refs.settings.close(); return; }
        if (this.previewShot) { this.previewShot = null; return; }
        if (this.showLaunchForm) { this.showLaunchForm = false; return; }
        if (this.moreOpen) { this.moreOpen = false; return; }
        if (this.showEdit) this.showEdit = false;
      };
      document.addEventListener("keydown", this._onKey);
      // Markdown 区链接全局拦截（捕获阶段，先于默认跳转）
      this._onMdClick = (e) => this.onMdLinkClick(e);
      document.addEventListener("click", this._onMdClick, true);
    },
    beforeUnmount() {
      window.removeEventListener("scroll", this.onScroll);
      document.removeEventListener("keydown", this._onKey);
      document.removeEventListener("click", this._onMdClick, true);
      this.stopRunPolling();   // 运行输出轮询定时器：离开页面必须清掉
    },
  });

  app.component("tree-node", TreeNode);
  app.component("lpa-select", window.LpaSelect);
  app.component("lpa-icon", window.LpaIcon);
  app.component("lpa-settings-dialog", window.LpaSettingsDialog);
  app.directive("modal", window.LpaModal);
  // 注入公共工具函数（fmtTime/copyText 等），供模板表达式调用
  Object.assign(app.config.globalProperties, window.LPA_HELPERS);
  app.mount("#app");
})();
