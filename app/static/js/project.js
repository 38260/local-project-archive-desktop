/* 项目详情页：元信息、笔记编辑、README 渲染、目录树、快捷操作 */
(function () {
  "use strict";
  const { createApp } = Vue;

  const DRAFT_PREFIX = "tl-draft-desc-";
  // 每个项目记住自己看过的那份 README 语言版本（多语言项目切换后刷新仍保持）
  const README_LANG_KEY = "tl-readme-lang-";
  // 与首页一致的默认字母/缩写图标规则（首页实现在 dashboard.js，详情页独立复用同一口径）
  const LOGO_COLORS = ["#2F81F7", "#22A66A", "#9061F9", "#D97706", "#DB2777", "#0D9488"];
  function projectInitials(name) {
    const text = String(name || "").trim();
    if (!text) return "?";
    if (/[\u3400-\u9fff]/.test(text[0])) return text.slice(0, 2);
    const words = text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[\s_.\-/\\]+/)
      .filter(Boolean);
    const letters = words.map(w => w[0]).filter(Boolean).join("");
    if (letters.length >= 2) return letters.slice(0, 2).toUpperCase();
    const first = words[0] || text;
    const pair = first.slice(0, 2);
    if (/^[a-z0-9]{2}$/i.test(pair)) return pair.toUpperCase();
    return (first.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?").toUpperCase();
  }

  // 详情页四个内容分区：内容用 v-show 保持挂载，草稿/筛选/折叠状态不会因切换丢失。
  const DETAIL_TABS = [
    { key: "overview", label: "概览", icon: "home" },
    { key: "launch", label: "启动与运行", icon: "play" },
    { key: "records", label: "开发记录", icon: "file-text" },
    { key: "materials", label: "项目资料", icon: "folder" },
  ];
  // 「本页内容」锚点：只列当前分区，避免和四个主分区重复堆叠
  const TAB_ANCHORS = {
    overview: [
      { id: "ov-progress", label: "最近进展", icon: "bar-chart" },
      { id: "ov-notes", label: "最近笔记", icon: "file-text" },
      { id: "ov-launch", label: "常用启动", icon: "play" },
      { id: "ov-readme", label: "项目简介", icon: "book" },
    ],
    launch: [
      { id: "sec-launch", label: "启动项与说明", icon: "play" },
      { id: "sec-runs", label: "运行历史", icon: "terminal" },
    ],
    records: [
      { id: "sec-desc", label: "项目描述", icon: "file-text" },
      { id: "sec-notes", label: "开发笔记", icon: "book" },
      { id: "sec-changelogs", label: "变更日志", icon: "list" },
      { id: "sec-commits", label: "Git 提交记录", icon: "commit" },
    ],
    materials: [
      { id: "sec-flowchart", label: "流程图", icon: "image" },
      { id: "sec-configs", label: "构建配置", icon: "package" },
      { id: "sec-stats", label: "文件统计", icon: "files" },
      { id: "sec-shots", label: "项目截图", icon: "image" },
      { id: "sec-readme", label: "README", icon: "book" },
    ],
  };
  const ANCHOR_TAB = (() => {
    const map = {};
    for (const [tab, list] of Object.entries(TAB_ANCHORS)) {
      for (const a of list) map[a.id] = tab;
    }
    // 兼容旧锚点/外部链接：先切到正确分区，再定位
    Object.assign(map, {
      "sec-info": "overview", "sec-git": "overview", "sec-personal": "records",
    });
    return map;
  })();
  // 描述预览防抖定时器（非响应式，放组件外即可）
  let descTimer = null;

  // 目录树中「双击可用系统默认应用打开」的文件类型。
  // 文档（.md/.txt）、网页（.html/.htm）、图片三类；图片扩展名与后端
  // _DOC_IMAGE_EXTS（app/routers/projects.py）保持一致，避免两边口径漂移。
  const OPENABLE_EXTS = new Set([
    "md", "markdown", "txt",
    "html", "htm",
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico",
    "avif", "jfif", "apng",
  ]);

  function isOpenableFile(name) {
    const dot = String(name || "").lastIndexOf(".");
    return dot >= 0 && OPENABLE_EXTS.has(String(name).slice(dot + 1).toLowerCase());
  }

  // 递归目录树组件
  // 文件节点交互：单击复制相对路径，双击用系统默认应用打开（文档 / 网页 / 图片）。
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
      // 可在应用外打开的类型（文档 / 网页 / 图片 → 交给系统默认应用）
      canOpen() {
        return !this.isDir && isOpenableFile(this.node.name);
      },
      fileTitle() {
        return this.canOpen
          ? `单击复制路径，双击用默认应用打开：${this.fileRel}`
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
          toast("该类型暂不支持双击打开（当前支持文档、网页、图片），已复制该文件路径", "error");
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
            <tl-icon :name="open ? 'folder-open' : 'folder'" :size="14"></tl-icon>
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
        readmeSwitching: false,
        tree: undefined, // undefined=加载中, null=失败
        notFound: false,
        // 非 404 的加载失败（500/网络断）：显示错误态+重试，避免永远停在骨架屏
        loadError: "",
        themeTick: 0,
        // 相邻项目（详情页左右切换）。
        // 初值取 common.js 的共享缓存（外壳脚本常驻，软导航不重跑）：
        // 列表非空时顶栏的 ‹ › 箭头首帧就能渲染成正确状态，
        // 否则会「先没箭头、数据回来再冒出来」，顶栏内容左右跳一下。
        siblings: (window.tlBriefSync && window.tlBriefSync()) || [],
        // 描述编辑：脏标记 + 本地草稿
        descBaseline: "",
        descDraftRestored: false,
        savingDesc: false,
        // 个人记录（项目描述 / 开发笔记 / 手写变更日志）：
        // 三块统一收纳，默认折叠。容器的展开偏好记在 localStorage（跨项目），
        // 子块每次进入详情页都收起——「需要记录时再打开」。
        personalOpen: localStorage.getItem("tl-personal-open") === "1",
        recordOpen: { desc: false, notes: false, logs: false },
        // 自动更新：进入页面 / 回到前台 / 桌面恢复时后台刷新采集数据。
        // state: idle 静默 | running 更新中 | done 已更新（短暂） | error 失败可重试
        autoRefresh: { state: "idle", reason: "", changed: false, at: "" },
        // 其他
        rescanning: false,
        showEdit: false,
        savingEdit: false,
        editForm: {},
        newPath: "",
        // 开发笔记（多条）
        notes: [],
        notesLoading: false,
        notesError: false,        // 加载失败标记：失败与「真没有笔记」分开显示
        noteDraft: null,          // null=收起编辑器，否则为草稿内容
        editingNoteId: null,
        editingNoteContent: "",
        // 变更日志
        changelogs: [],
        logsError: false,
        logDraft: null,
        logDraftTitle: "",
        logDraftDate: "",
        editingLogId: null,
        editLogForm: { title: "", content: "", entry_date: "" },
        // Git 提交记录
        commitAuthors: localStorage.getItem("tl-commit-authors") === "all" ? "all" : "mine",
        gitRevision: 0,
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
        // 概览“最近进展”：固定当前项目 / 近 7 天 / 仅本人，与开发记录作者筛选隔离
        recentActivity: null,
        recentActivityLoading: true,
        recentActivityError: "",
        recentCommits: null,
        recentCommitsLoading: true,
        recentCommitsError: "",
        recentRevision: 0,
        // 按月提交柱状图：后端 /heatmap 固定取一年按天数据，前端聚合到日历月
        heat: null,
        monthSpan: 12,          // 柱状图月数（6=半年 | 12=一年），被设置 ui.heatmap_weeks 覆盖
        // 月柱状图默认折叠：它与下方「提交构成分析」里的类型×月份堆叠柱信息重叠，
        // 折叠后仍保留"共 N 次提交"的摘要可见，需要细节再展开。状态记忆在 localStorage，
        // 判据写成 `!== "0"`（即默认折叠），用户展开过一次后才记住"展开"。
        monthCollapsed: localStorage.getItem("tl-month-collapsed") !== "0",
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
        launchPrefsSaving: false,
        launchBusyKey: null,    // 启动中防连点
        launchForm: { id: null, name: "", command: "", cwd: "", mode: "console" },
        // 启动面板展示偏好（随 GET /launch 一起回来，落库在 projects.launch_prefs）：
        //   launchOrder   入口展示顺序（键数组，见 entryKey）
        //   launchPrimary 顶部「启动」按钮默认跑哪个入口；null = 取顺序里的第一项
        //   launchHidden  被移除的自动检测入口键：重新检测不再出现（脚本不删，可恢复）
        launchOrder: [],
        launchPrimary: null,
        launchHidden: [],
        editSourceKey: null,    // 正在「编辑自动检测入口」时记录原入口键（保存后转存覆盖）
        launchMenuOpen: false,  // 顶栏「启动」按钮的下拉是否展开
        launchDragKey: null,    // 正在拖拽的入口键（null = 没在拖）
        // 捕获运行与运行历史：勾选后后台执行并采集输出/退出码（记忆上次选择）
        runCapture: localStorage.getItem("tl-run-capture") === "1",
        runs: [],               // 运行历史列表（不含输出正文）
        runsLoading: false,
        runsError: false,
        runOpenId: null,        // 当前展开输出查看的运行 id
        runDetail: null,        // 展开运行的详情（状态/退出码/耗时）
        runLines: [],           // 已拉取到的输出行
        runOffset: 0,           // 已拉取行数（增量轮询用）
        runStopping: false,
        // 流程图（GET /flowchart：candidates 自动候选 / current 当前展示 / custom_files 上传历史）
        flowchart: null,
        flowchartLoading: false,
        flowchartError: false,
        showFlowPicker: false,
        flowUploading: false,
        flowZoom: null,         // 流程图放大预览（null=关闭；打开时为当前展示对象）
        // 截图
        screenshots: [],
        shotsError: false,
        previewShot: null,
        uploadingShots: false,
        uploadCount: 0,
        shotsDrag: false,
        // 更多菜单 / 描述实时预览
        moreOpen: false,
        headMoreOpen: true,      // 头部“更多信息”展开区，默认展开
        descLive: "",
        // 目录树按需抽屉：首次默认关闭；开关状态按本机偏好记住
        treeOpen: localStorage.getItem("tl-tree-open") === "1",
        // 四个内容分区与页内锚点
        tabs: DETAIL_TABS,
        activeTab: "overview",
        activeSection: "ov-progress",
        sectionScroll: { overview: 0, launch: 0, records: 0, materials: 0 },
        spySuspendedUntil: 0,
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
        // 跟随系统时仍显示当前解析出的外观（日/月），比显示器图标更易读；
        // 偏好本身仍在 title 中完整说明。
        const dark = pref === "dark"
          || (pref === "auto" && document.documentElement.getAttribute("data-theme") === "dark");
        return dark ? "moon" : "sun";
      },
      themeLabel() {
        this.themeTick;
        return window.themeName();
      },
      descDirty() {
        return ((this.p && this.p.description) || "") !== this.descBaseline;
      },
      hasDescDraft() { return this.descDraftRestored; },
      // ---- 个人记录（折叠区）摘要：收起时也能看出有没有内容 ----
      descSummary() {
        const t = ((this.p && this.p.description) || "").trim();
        return t ? `已填写 ${t.length} 字` : "未填写";
      },
      notesSummary() {
        if (this.notesError) return "加载失败";
        if (!this.notes.length) return this.noteDraft !== null ? "编辑中" : "暂无";
        return `${this.notes.length} 条`;
      },
      logsSummary() {
        if (this.logsError) return "加载失败";
        if (!this.changelogs.length) return this.logDraft !== null ? "编辑中" : "暂无";
        return `${this.changelogs.length} 条`;
      },
      personalSummary() {
        const t = ((this.p && this.p.description) || "").trim();
        return [
          t ? `描述 ${t.length} 字` : "描述未填",
          `笔记 ${this.notes.length}`,
          `变更 ${this.changelogs.length}`,
        ].join(" · ");
      },
      // 折叠状态下也要暴露未保存状态（描述草稿 / 笔记草稿 / 日志草稿）
      personalDirty() {
        return this.descDirty
          || (this.noteDraft != null && String(this.noteDraft).trim() !== "")
          || (this.logDraft != null && String(this.logDraft).trim() !== "");
      },
      prevProject() {
        const i = this.siblings.findIndex(s => s.id === this.projectId);
        return i > 0 ? this.siblings[i - 1] : null;
      },
      nextProject() {
        const i = this.siblings.findIndex(s => s.id === this.projectId);
        return (i >= 0 && i < this.siblings.length - 1) ? this.siblings[i + 1] : null;
      },
      // 紧凑头部的时间文案：今天/昨天显示到时分，更早显示日期
      headModifiedText() {
        const iso = this.p && this.p.fs_modified;
        if (!iso) return "未知";
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "未知";
        const now = new Date();
        const dayStart = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((dayStart(now) - dayStart(d)) / 86400000);
        const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        if (diff === 0) return `今天 ${hm}`;
        if (diff === 1) return `昨天 ${hm}`;
        if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
      },
      // 紧凑头部摘要：优先 README 解析出的 intro，其次项目描述首行
      headSummary() {
        const intro = ((this.meta && this.meta.intro) || (this.p && this.p.intro) || "").trim();
        if (intro) return intro;
        const desc = ((this.p && this.p.description) || "").trim();
        return desc ? desc.split("\n").find(x => x.trim()) || "" : "";
      },
      // 更多信息中的 Git 贡献者一行展示上限（完整字段仍保留在展开区）
      headBranch() {
        const g = this.gitInfo;
        return g && g.is_repo ? (g.branch || "") : "";
      },
      // ---- 概览：最近进展（固定当前项目 / 近 7 天 / 仅本人） ----
      recentProgress() {
        const heat = this.recentActivity;
        const now = new Date();
        const fallbackEnd = this.localDateKey(now);
        const fallbackStart = this.localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
        const startKey = (heat && heat.start) || fallbackStart;
        const endKey = (heat && heat.end) || fallbackEnd;
        const start = this.parseDateKey(startKey) || new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
        const end = this.parseDateKey(endKey) || now;
        const dates = [];
        const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const limit = new Date(end.getFullYear(), end.getMonth(), end.getDate());
        while (cursor <= limit && dates.length < 31) {
          dates.push(new Date(cursor));
          cursor.setDate(cursor.getDate() + 1);
        }
        const counts = (heat && heat.days) || {};
        const todayKey = this.localDateKey(now);
        const rawError = this.recentActivityError || (heat && heat.error) || "";
        const emptyRepo = /仓库为空|没有任何提交/.test(rawError);
        let total = 0;
        const days = dates.map(d => {
          const key = this.localDateKey(d);
          const count = Number(counts[key] || 0);
          total += count;
          return {
            key,
            label: `${d.getMonth() + 1}/${d.getDate()}`,
            weekday: `周${["日", "一", "二", "三", "四", "五", "六"][d.getDay()]}`,
            count,
            today: key === todayKey,
            tip: `${key} ${["日", "一", "二", "三", "四", "五", "六"][d.getDay()]}：${count} 次提交`,
          };
        });
        const max = Math.max(1, ...days.map(d => d.count));
        for (const d of days) d.pct = d.count ? Math.max(4, (d.count / max) * 100) : 0;
        return {
          loading: this.recentActivityLoading,
          identityRequired: !!(heat && heat.identity_required),
          isRepo: heat ? !!heat.is_repo : null,
          lost: !!(this.p && this.p.is_lost),
          error: emptyRepo ? "" : rawError,
          emptyRepo,
          startKey, endKey,
          days,
          total,
          activeDays: days.filter(d => d.count > 0).length,
          max,
          color: this.logoColor(this.p),
          startLabel: days.length ? days[0].label : "",
          endLabel: days.length ? days[days.length - 1].label : "",
        };
      },
      recentCommitErrorText() {
        const raw = this.recentCommitsError
          || ((this.recentCommits && this.recentCommits.error) || "");
        return /仓库为空|没有任何提交/.test(raw) ? "" : raw;
      },
      recentCommitList() {
        const data = this.recentCommits;
        if (!data || !data.is_repo || !Array.isArray(data.commits)) return [];
        const range = this.recentProgress;
        // git log 默认按提交图顺序；概览要按提交时间倒序展示真正的“最近”
        return data.commits
          .filter(c => {
            const key = this.dateKeyOfIso(c.date);
            return key && key >= range.startKey && key <= range.endKey;
          })
          .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
          .slice(0, 3);
      },
      recentNotes() {
        return this.notes.slice().sort((a, b) =>
          String(b.updated_at || b.created_at || "")
            .localeCompare(String(a.updated_at || a.created_at || ""))
        ).slice(0, 2);
      },
      // 真没有笔记时概览右列让给常用启动；加载中（骨架）与加载失败（可重试）仍保留面板
      showNotesPanel() {
        return this.notesLoading || this.notesError || this.recentNotes.length > 0;
      },
      overviewLaunches() {
        return this.orderedEntries.slice(0, 2);
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
        const authors = this.commitAuthors === "mine" ? "仅本人" : "全部作者";
        return authors + " · " + (st.truncated ? `基于最近 ${n} 次提交（已截断）` : `全量 ${n} 次提交`);
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
      // 已转存为自定义启动项、或被用户移除的自动检测建议不再重复展示
      // （前者按 mode+cwd+command 去重，后者按入口键）
      visibleSuggestions() {
        if (!this.launch) return [];
        const saved = new Set((this.launch.launchers || [])
          .map(l => `${l.mode}|${(l.cwd || "").trim()}|${l.command.trim()}`));
        const hidden = new Set(this.launchHidden);
        return (this.launch.suggestions || [])
          .filter(s => !saved.has(`${s.mode}|${(s.cwd || "").trim()}|${s.command.trim()}`)
            && !hidden.has(this.entryKey(s)));
      },
      // 已移除且当前检测仍在命中的自动入口（有名字可展示、可一键恢复；
      // 项目内容变了导致键对不上的旧记录保持静默隐藏，不影响列表）
      hiddenSuggestions() {
        if (!this.launch || !this.launchHidden.length) return [];
        const hidden = new Set(this.launchHidden);
        return (this.launch.suggestions || []).filter(s => hidden.has(this.entryKey(s)));
      },
      // 全部入口（自定义 + 自动检测混排）按用户拖出来的顺序排好。
      // 顺序里没出现过的入口一律排在最后、保持各自原有次序：
      // 这样新检测出来的入口只会追加到末尾，不会打乱用户已经拖好的位置。
      orderedEntries() {
        if (!this.launch) return [];
        const all = [];
        (this.launch.launchers || []).forEach((e, i) =>
          all.push({ key: this.entryKey(e), kind: "l", entry: e, nat: i }));
        this.visibleSuggestions.forEach((e, i) =>
          all.push({ key: this.entryKey(e), kind: "s", entry: e, nat: i }));
        const pos = new Map();
        this.launchOrder.forEach((k, i) => { if (!pos.has(k)) pos.set(k, i); });
        return all
          .map(x => ({ ...x, at: pos.has(x.key) ? pos.get(x.key) : Infinity }))
          .sort((a, b) => (a.at - b.at) || (a.nat - b.nat));
      },
      // 自动检测入口的来源说明（统一列表里的「自动检测」标签悬浮提示用）
      detectKindText() {
        const map = {
          direct: "项目内可执行文件",
          direct_weak: "项目内脚本（未能确认是否为启动方式，建议核对后再点）",
          inferred: "构建配置推断",
        };
        return (this.launch && map[this.launch.detect_kind]) || "项目内扫描";
      },
      // 启动项编辑弹窗标题：编辑已有 / 编辑自动入口（转存覆盖）/ 新增
      launchFormTitle() {
        if (this.launchForm.id) return "编辑启动项";
        return this.editSourceKey ? "编辑自动检测入口" : "添加启动项";
      },
      // 顶部「启动」主按钮跑哪一个：优先用下拉里显式指定的那个；
      // 没指定（或指定的入口已不存在）就取顺序里的第一项。
      primaryLaunchEntry() {
        if (!this.launch || !this.launch.supported) return null;
        const all = this.orderedEntries;
        if (!all.length) return null;
        if (this.launchPrimary) {
          const hit = all.find(x => x.key === this.launchPrimary);
          if (hit) return hit.entry;
        }
        return all[0].entry;
      },
      // 有运行中的记录时，面板标题显示数量提示
      runningCount() {
        return (this.runs || []).filter(r => r.running).length;
      },
      // 「本页内容」：只展示当前分区中真实存在的锚点
      activeAnchors() {
        return this.anchorsForTab(this.activeTab);
      },
      activeTabLabel() {
        const tab = DETAIL_TABS.find(t => t.key === this.activeTab);
        return tab ? tab.label : "";
      },
      // README 语言版本：候选列表（根目录内所有 README*）与实际渲染的那一份
      readmeVariants() { return (this.readme && this.readme.variants) || []; },
      readmeActive() { return (this.readme && this.readme.active) || ""; },
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
        if (this.readme && this.readme.raw) await this.copyText(this.readme.raw, "README 原文");
      },
      // 切换 README 语言版本：偏好按项目记在 localStorage，下次进来还是看这一份
      async switchReadme(v) {
        if (this.readmeSwitching || !this.readme || this.readme.active === v.file) return;
        this.readmeSwitching = true;
        try {
          this.readme = await api(
            `/api/projects/${this.projectId}/readme?file=${encodeURIComponent(v.file)}`);
          localStorage.setItem(README_LANG_KEY + this.projectId, v.file);
        } catch (e) {
          // 读取失败（文件被删/无权限）：保留当前版本，不让面板塌成「未找到 README」
        } finally {
          this.readmeSwitching = false;
        }
      },
      // README 头部常见的「[English](README_EN.md) | [中文](README.md)」语言切换链接：
      // 命中根目录内的某个 README 版本时直接换面板内容，不再盖一层文档查看器浮层。
      readmeVariantByRel(rel) {
        if (!rel || rel.indexOf("/") >= 0) return null;   // 只认根目录内的版本文件
        const low = rel.toLowerCase();
        return this.readmeVariants.find(v => v.file.toLowerCase() === low) || null;
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
        const variant = this.readmeVariantByRel(rel);
        if (variant) { this.switchReadme(variant); return; }
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
      // 目录树节点的 rel 以「项目文件夹名」为根（后端 build_tree 把项目目录本身也当作
      // 根节点），而读取文件需要「项目内相对路径」；越界或无法定位时返回 null。
      toProjectInnerRel(rel) {
        const clean = this.normalizeRel(rel);
        if (!clean) return null;
        const root = (this.tree && this.tree.name) || "";
        let inner = clean;
        if (root && (clean === root || clean.startsWith(root + "/"))) {
          inner = clean.slice(root.length).replace(/^\/+/, "");
        }
        return inner || null;
      },
      // 目录树双击：用系统默认应用打开项目内文件（不在应用内预览，
      // 与在资源管理器里双击该文件等效；.md 若无关联程序会由系统弹出「打开方式」）
      async openProjectFile(rel) {
        const inner = this.toProjectInnerRel(rel);
        if (!inner) { toast("无法定位该文件在项目内的相对路径", "error"); return; }
        try {
          const r = await api(`/api/projects/${this.projectId}/open-file`,
            { method: "POST", body: { rel: inner } });
          toast(`已用默认应用打开：${r.name || inner}`, "ok");
        } catch (e) { /* toast 已提示 */ }
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
      // 只在详情数据成功加载后记录一次。软导航/整页导航都走同一入口；
      // 404、网络失败或被后续导航卸载时不写，避免覆盖旧时间。
      recordVisit() {
        if (this._visitRecorded || this._disposed) return;
        this._visitRecorded = true;
        api(`/api/projects/${this.projectId}/visit`, { method: "POST", silent: true })
          .then(r => { if (this.p && r) this.p.last_opened_at = r.last_opened_at; })
          .catch(e => console.warn("[tl] 访问时间记录失败：", e));
      },
      async load() {
        this.loadError = "";
        try {
          const p = await api(`/api/projects/${this.projectId}`);
          this.p = p;
          this.statuses = p.statuses || [];
          this.meta = p.auto_meta || {};
          this.newPath = p.is_lost ? "" : p.path;
          this.syncDesc();
          this.restoreDescDraft();
          if (p.is_lost) this.treeOpen = false;
          this.loadSiblings();
          this.loadReadme();
          if (this.treeOpen) this.loadTree();
          this.loadNotes();
          this.loadChangelogs();
          this.loadShots();
          this.loadFlowchart();
          this.loadLaunch();
          this.loadRuns();
          // 先拿设置（决定提交记录加载数），再加载提交与热力图
          await this.loadPrefs();
          this.reloadGit();
        } catch (e) {
          if (e.status === 404) this.notFound = true;
          else this.loadError = e.message || "加载失败";
        }
      },
      // ---- 自动更新（进入页面 / 回到前台 / 桌面恢复）----
      // 先渲染已有内容，后台刷新采集数据，完成后只替换受影响的部分；
      // 描述 / 笔记 / 日志 / 启动项这些带草稿的状态一律不动。
      autoRefreshStart(force) {
        if (this._disposed) return;
        clearTimeout(this._refreshTimer);
        // focus 与 visibilitychange 往往同时来，合并成一次请求（服务端还有 30s 冷却）
        this._refreshTimer = setTimeout(() => this.runAutoRefresh(!!force), force ? 0 : 300);
      },
      async runAutoRefresh(force) {
        if (this._disposed || !this.p || this._refreshing) return;
        const pid = this.projectId;
        this._refreshing = true;
        this.autoRefresh.state = "running";
        this.autoRefresh.reason = "";
        try {
          const r = await api("/api/refresh", {
            method: "POST", body: { ids: [pid], force: !!force }, silent: true,
          });
          if (this._disposed || pid !== this.projectId) return;
          if (!r || !r.job_id) {          // 冷却中：静默结束，不打扰
            this.autoRefresh.state = "idle";
            return;
          }
          const job = await this.pollRefreshJob(r.job_id, pid);
          if (this._disposed || pid !== this.projectId) return;
          if (!job) throw new Error("刷新任务超时");
          const item = (job.items || []).find(x => x.id === pid);
          if (!item) { this.autoRefresh.state = "idle"; return; }
          if (item.ok === false) {
            this.autoRefresh.state = "error";
            this.autoRefresh.reason = item.reason || "刷新失败";
            return;
          }
          this.autoRefresh.at = item.refreshed_at || "";
          this.autoRefresh.changed = !!item.changed;
          if (item.changed) await this.applyAutoRefresh(pid);
          this.autoRefresh.state = "done";
          setTimeout(() => {
            if (!this._disposed && this.autoRefresh.state === "done") this.autoRefresh.state = "idle";
          }, 2500);
        } catch (e) {
          if (!this._disposed && pid === this.projectId) {
            this.autoRefresh.state = "error";
            const raw = (e && e.message) || "";
            // fetch 层失败的原文（Failed to fetch）对用户没有意义，换成能行动的提示
            this.autoRefresh.reason = /Failed to fetch|NetworkError|Load failed/i.test(raw)
              ? "无法连接本地服务，请确认程序仍在运行"
              : (raw || "刷新失败");
          }
        } finally {
          this._refreshing = false;
        }
      },
      // 轮询任务；切换项目 / 页面卸载 / 任务过期都立即放弃
      async pollRefreshJob(jobId, pid) {
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 600));
          if (this._disposed || pid !== this.projectId) return null;
          try {
            const j = await api(`/api/refresh/${jobId}`, { silent: true });
            if (j.state === "done") return j;
          } catch (e) {
            if (e.status === 404) return null;
          }
        }
        return null;
      },
      // 局部替换：只换采集数据与派生视图，保留所有编辑中的草稿
      async applyAutoRefresh(pid) {
        const latest = await api(`/api/projects/${pid}`, { silent: true });
        if (this._disposed || pid !== this.projectId) return;
        const dirty = this.descDirty;
        this.p = Object.assign({}, latest, {
          // 有未保存描述时保留用户输入；否则用服务端最新值
          description: dirty ? this.p.description : latest.description,
        });
        this.meta = latest.auto_meta || {};
        this.statuses = latest.statuses || this.statuses;
        this.newPath = latest.is_lost ? "" : latest.path;
        // 脏状态下不动基线/预览，否则草稿会被误判成已保存
        if (!dirty) {
          this.descBaseline = latest.description || "";
          this.descLive = latest.description_html || "";
        }
        this.loadReadme();
        if (this.treeOpen) this.loadTree();
        this.loadFlowchart();
        await this.reloadGitQuiet();
      },
      // 静默重载 Git 视图：不显示骨架屏，也不清用户的类型筛选与展开状态
      async reloadGitQuiet() {
        this.gitRevision++;
        await Promise.all([
          this.loadCommits(false, true),
          this.loadCommitStats(true),
          this.loadHeatmap(),
          this.loadRecentActivity(),
        ]);
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
      },
      // ---- 设置（共享弹窗，见 js/settings.js；首页同款） ----
      openSettings() { this.$refs.settings.open(); },
      // 设置变更联动：prefs=编辑器命令/提交加载数/热力图范围随改随生效；
      // data=数据被恢复/清空，整页重载（load 自带 404 处理）
      async onSettingsChanged(kind, key) {
        this.themeTick++;   // 主题可能被设置弹窗改过，顶栏按钮文字/图标需刷新
        if (kind === "data") { this.load(); return; }
        await this.loadPrefs();
        if (["git.author_emails", "commits.limit", "ui.heatmap_weeks"].includes(key)) this.reloadGit();
      },
      setCommitAuthors(authors) {
        if (authors === this.commitAuthors) return;
        this.commitAuthors = authors;
        localStorage.setItem("tl-commit-authors", authors);
        this.reloadGit();
      },
      reloadGit() {
        this.gitRevision++;
        this.commitData = this.commitStats = this.heat = null;
        this.commitTypeFilter = "";
        return Promise.all([
          this.loadCommits(), this.loadCommitStats(), this.loadHeatmap(),
          this.loadRecentActivity(),
        ]);
      },
      // ---- 流程图（自动识别 / 选择替换 / 上传） ----
      async loadFlowchart() {
        if (this.p && this.p.is_lost) { this.flowchart = null; return; }
        this.flowchartLoading = true;
        try {
          this.flowchart = await api(`/api/projects/${this.projectId}/flowchart`,
            { silent: true });
          this.flowchartError = false;
        } catch (e) {
          this.flowchart = null;
          this.flowchartError = true;   // 失败与「真没有流程图」分开显示
        } finally { this.flowchartLoading = false; }
      },
      // 选择候选 / 上传历史图 / 恢复自动识别（choice=null）
      async chooseFlowchart(choice) {
        try {
          await api(`/api/projects/${this.projectId}/flowchart-prefs`, {
            method: "PUT", body: { choice },
          });
          await this.loadFlowchart();
          toast(choice ? "流程图已更新" : "已恢复自动识别", "ok");
        } catch (e) { /* toast 已提示 */ }
      },
      async uploadFlowchart(e) {
        const file = (e.target.files || [])[0];
        e.target.value = "";
        if (!file) return;
        await this.postFlowchart(file);
      },
      async postFlowchart(file) {
        this.flowUploading = true;
        try {
          const fd = new FormData();
          fd.append("file", file);
          const resp = await fetch(`/api/projects/${this.projectId}/flowchart/upload`, {
            method: "POST", body: fd,
          });
          const r = await resp.json();
          if (!resp.ok) throw new Error(r.detail || "上传失败");
          toast("流程图已保存并启用", "ok");
          await this.loadFlowchart();   // 失败时不会走到这里，旧图继续展示
        } catch (err) {
          toast("流程图上传失败：" + err.message, "error");
        } finally { this.flowUploading = false; }
      },
      // ---- 快速启动（检测/说明/自定义项/执行） ----
      async loadLaunch() {
        if (this.launchPrefsSaving) return;
        if (this.p && this.p.is_lost) { this.launch = null; return; }
        this.launchLoading = true;
        try {
          const d = await api(`/api/projects/${this.projectId}/launch`, { silent: true });
          this.launch = d;
          this.launchOrder = Array.isArray(d.order) ? d.order : [];
          this.launchPrimary = d.primary || null;
          this.launchHidden = Array.isArray(d.hidden) ? d.hidden : [];
        } catch (e) {
          this.launch = null;   // 检测失败不影响详情页其他面板
        } finally { this.launchLoading = false; }
      },
      // ---- 启动面板：入口键 / 排序 / 顶部默认项 ----
      // 入口的唯一键：自定义项用数据库 id（改名改命令都不影响）；
      // 自动检测项不落库，用「模式|子目录|命令」指纹当键，重新检测后仍能对上。
      entryKey(e) {
        if (e && e.id != null) return "l:" + e.id;
        return "s:" + (e.mode || "console") + "|" + ((e.cwd || "").trim())
          + "|" + ((e.command || "").trim());
      },
      isPrimaryEntry(e) { return this.primaryLaunchEntry === e; },
      // 下拉里选中某一项 = 把它设为顶部「启动」按钮的默认项（不改动列表顺序）
      setPrimaryEntry(e) {
        if (this.launchPrefsSaving) return;
        this.launchMenuOpen = false;
        this.launchPrimary = this.entryKey(e);
        return this.saveLaunchPrefs();
      },
      async saveLaunchPrefs() {
        if (!this.launch || this.launchPrefsSaving) return false;
        this.launchPrefsSaving = true;
        try {
          const saved = await api(`/api/projects/${this.projectId}/launch-prefs`, {
            method: "PUT", silent: true,
            body: { order: this.launchOrder, primary: this.launchPrimary,
                    hidden: this.launchHidden },
          });
          Object.assign(this.launch, { order: saved.order, primary: saved.primary,
                                      hidden: saved.hidden });
          this.launchOrder = saved.order.slice();
          this.launchPrimary = saved.primary;
          this.launchHidden = saved.hidden.slice();
          return true;
        } catch (e) {
          this.launchOrder = (this.launch.order || []).slice();
          this.launchPrimary = this.launch.primary || null;
          this.launchHidden = (this.launch.hidden || []).slice();
          toast("启动项偏好保存失败，已恢复原状态", "error");
          return false;
        } finally { this.launchPrefsSaving = false; }
      },
      // ---- 拖拽排序：HTML5 DnD，实时换位，未引入任何拖拽库 ----
      onLaunchDragStart(e, ev) {
        if (this.launchPrefsSaving) { ev.preventDefault(); return; }
        this.launchDragKey = this.entryKey(e);
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = "move";
          ev.dataTransfer.setData("text/plain", this.launchDragKey); // 少了这行部分浏览器不启动拖拽
        }
      },
      onLaunchDragOver(e, ev) {
        if (this.launchDragKey == null) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
        const key = this.entryKey(e);
        if (key === this.launchDragKey) return;
        const keys = this.orderedEntries.map(y => y.key);
        const from = keys.indexOf(this.launchDragKey);
        const to = keys.indexOf(key);
        if (from < 0 || to < 0) return;
        // 布局是 flex-wrap（可能多行）：指针落在目标同一行就比横坐标中线，
        // 落在别的行就比纵坐标中线。只依赖指针与目标自身的位置，
        // 不用被拖元素的矩形——它每换一次位就会动，容易来回抖。
        const r = ev.currentTarget.getBoundingClientRect();
        const inRow = ev.clientY >= r.top && ev.clientY <= r.bottom;
        const after = inRow
          ? (ev.clientX - r.left) > r.width / 2
          : (ev.clientY - r.top) > r.height / 2;
        let target = after ? to + 1 : to;
        if (target > from) target -= 1;
        if (target === from) return;
        keys.splice(target, 0, keys.splice(from, 1)[0]);
        this.launchOrder = keys;
      },
      onLaunchGridDragOver(ev) { if (this.launchDragKey != null) ev.preventDefault(); },
      onLaunchDragEnd() {
        if (this.launchDragKey == null) return;
        this.launchDragKey = null;
        return this.saveLaunchPrefs();   // 拖完立刻落盘，刷新后顺序不变
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
          localStorage.setItem("tl-run-capture", capture ? "1" : "0");
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
        this.runsError = false;
        try {
          const r = await api(`/api/projects/${this.projectId}/runs?limit=10`,
            { silent: true });
          this.runs = r.runs || [];
        } catch (e) { this.runs = []; this.runsError = true; }   // 失败与「无记录」分开显示
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
        if (!await confirmDialog(
          "确定删除这条运行记录吗？\n\n记录含完整的命令输出日志，删除后不可恢复。",
          { title: "删除运行记录", okText: "删除", danger: true })) return;
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
      // 「添加启动项」里点「浏览…」：弹系统文件选择框（默认就打开在该项目根目录），
      // 进文件夹后双击文件即选中，把该文件作为启动入口填进「命令」。
      // 与录入页选文件夹共用同一套 pywebview 桥，浏览器模式没有桥 → 降级为提示。
      async browseLaunchFile() {
        const bridge = window.pywebview && window.pywebview.api;
        if (!bridge || typeof bridge.select_file !== "function") {
          toast("浏览器模式下不支持文件选择，请直接粘贴完整路径", "error");
          return;
        }
        let file;
        try {
          const root = (this.p && !this.p.is_lost && this.p.path) || "";
          file = await bridge.select_file(root);
        } catch (e) {
          toast("选择文件失败：" + (e.message || e), "error");
          return;
        }
        if (!file) return;                       // 用户取消
        if (file.length > 500) {
          toast("文件路径过长（超过 500 字符），无法作为启动命令", "error");
          return;
        }
        const f = this.launchForm;
        // 与后端 LAUNCH_DIRECT_EXTS 口径一致：可直接双击运行的类型默认「直接运行」；
        // 其余类型（.py / .sh 等需要解释器）保持用户当前的运行方式，由用户补参数。
        if (/\.(exe|bat|cmd|ps1)$/i.test(file)) f.mode = "open";
        // 引号口径随运行方式走，两种模式不能混：
        //   「直接运行」走 os.startfile，路径必须原样（带引号会被当成路径的一部分）；
        //   「新终端窗口」是把命令拼进 cmd /k，路径含空格必须加引号。
        f.command = (f.mode === "open" || !/\s/.test(file)) ? file : `"${file}"`;
        if (!f.name.trim()) f.name = file.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
      },
      openLaunchForm(entry, suggestion) {
        if (entry) {
          this.launchForm = { id: entry.id, name: entry.name, command: entry.command,
                              cwd: entry.cwd || "", mode: entry.mode || "console" };
          this.editSourceKey = null;          // 编辑自定义项：与自动项无关
        } else if (suggestion) {
          // 编辑自动检测入口：预填后保存为自定义覆盖项，并记住原建议的指纹，
          // 新建和覆盖关系由后端在同一事务保存。
          this.launchForm = { id: null, name: suggestion.name, command: suggestion.command,
                              cwd: suggestion.cwd || "", mode: suggestion.mode || "console" };
          this.editSourceKey = this.entryKey(suggestion);
        } else {
          this.launchForm = { id: null, name: "", command: "", cwd: "", mode: "console" };
          this.editSourceKey = null;
        }
        this.showLaunchForm = true;
      },
      closeLaunchForm() {
        this.showLaunchForm = false;
        this.editSourceKey = null;
      },
      // 移除自动检测入口：只从列表隐藏（launch_prefs.hidden），不删除任何脚本；
      // 重新检测不会再次出现，列表下方提供恢复入口
      async removeSuggestion(s) {
        if (this.launchPrefsSaving) return;
        const key = this.entryKey(s);
        if (!this.launchHidden.includes(key)) {
          this.launchHidden = this.launchHidden.concat(key);
        }
        if (this.launchPrimary === key) this.launchPrimary = null;   // 回落到顺序第一项
        if (await this.saveLaunchPrefs()) {
          toast(`已移除自动检测入口「${s.name}」，脚本未删除，可随时恢复`, "ok");
        }
      },
      async restoreSuggestion(s) {
        if (this.launchPrefsSaving) return;
        this.launchHidden = this.launchHidden.filter(k => k !== this.entryKey(s));
        if (await this.saveLaunchPrefs()) toast(`已恢复「${s.name}」`, "ok");
      },
      async saveLaunchForm() {
        if (this.launchPrefsSaving || this.launchFormSaving) return;
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
            if (this.editSourceKey) {
              body.source_key = this.editSourceKey;
              body.override_prefs = { order: this.orderedEntries.map(x => x.key),
                primary: this.launchPrimary, hidden: this.launchHidden };
            }
            await api(`/api/projects/${this.projectId}/launchers`, { method: "POST", body });
          }
          this.showLaunchForm = false;
          this.editSourceKey = null;
          toast(f.id ? "启动项已更新" : "启动项已添加", "ok");
          await this.loadLaunch();
        } catch (e) { /* toast 已提示 */ }
        finally { this.launchFormSaving = false; }
      },
      async deleteLauncher(l) {
        if (!await confirmDialog(`删除启动项「${l.name}」？删除后不可恢复。`,
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
        const revision = this.gitRevision;
        try {
          const result = await api(
            `/api/projects/${this.projectId}/heatmap?weeks=53&authors=${this.commitAuthors}`, { silent: true });
          if (revision === this.gitRevision) this.heat = result;
        } catch (e) {
          if (revision === this.gitRevision) this.heat = null;
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
          // 恢复的草稿不能藏在折叠区里：直接展开容器与描述块
          // （只改本次会话的展开态，不动 localStorage 里的偏好）
          this.personalOpen = true;
          this.recordOpen.desc = true;
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
          // 轻量接口：只取 id/name/alias，不做磁盘校验。
          // 走 common.js 的共享缓存，与顶部标签栏共用一次请求。
          const list = window.tlRefreshBrief
            ? await window.tlRefreshBrief()
            : ((await api("/api/projects/brief", { silent: true })).projects || []);
          this.siblings = list;
        } catch (e) { /* 失败就沿用缓存里的旧值，顶栏箭头不至于消失 */ }
      },
      gotoSibling(target) { if (target) this.leaveConfirm("/project/" + target.id); },
      // 离开详情页的统一出口：有未保存草稿时先应用内确认，再跳转。
      // 不用原生 beforeunload——打包为 pywebview(WebView2) 后该原生确认框可能被宿主窗口
      // 盖住/失焦而不可见，用户点「返回首页」毫无反应，表现为「打开后退不出来」。
      // 描述草稿本身会落 localStorage（下次进入自动恢复），笔记/日志草稿离开即丢，
      // 提示文案如实区分，让用户自己决定。
      leaveConfirm(url) {
        // 编辑中的既有笔记/日志也算未保存：与原内容比对，只在真改过时才拦
        // （只打开编辑框没动字，不弹确认，避免打扰）
        const editingNote = this.editingNoteId != null
          && this.notes.some(n => n.id === this.editingNoteId
            && n.content !== this.editingNoteContent);
        const editingLog = this.editingLogId != null
          && this.changelogs.some(c => c.id === this.editingLogId
            && (c.title !== this.editLogForm.title
              || c.content !== this.editLogForm.content
              || c.entry_date !== this.editLogForm.entry_date));
        const hasUnsaved = this.descDirty
          || (this.noteDraft != null && String(this.noteDraft).trim())
          || (this.logDraft != null && String(this.logDraft).trim())
          || editingNote || editingLog;
        if (!hasUnsaved) { window.tlSoftNavigate(url); return; }
        confirmDialog(
          "当前页面有未保存的内容（描述、笔记或变更日志）。\n\n"
          + "描述草稿会自动保留，下次打开本项目可继续编辑；"
          + "尚未保存的笔记 / 日志（含正在编辑的修改）离开后将丢失。",
          { title: "离开详情页", okText: "仍然离开" })
          .then(ok => { if (ok) window.tlSoftNavigate(url); });
      },
      switchTheme() { window.cycleTheme(); this.themeTick++; },
      projectInitials(name) { return projectInitials(name); },
      logoColor(project) {
        const id = Number(project && project.id) || 1;
        return LOGO_COLORS[Math.abs(id - 1) % LOGO_COLORS.length];
      },
      toggleHeadMore() { this.headMoreOpen = !this.headMoreOpen; },
      openEditFromMenu() {
        this.moreOpen = false;
        this.openEdit();
      },
      localDateKey(date) {
        const d = date instanceof Date ? date : new Date(date);
        if (Number.isNaN(d.getTime())) return "";
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      },
      parseDateKey(key) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
        return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
      },
      dateKeyOfIso(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? "" : this.localDateKey(d);
      },
      // 概览只展示纯文本摘要，不截断/注入已有 HTML；完整 Markdown 仍在原分区安全渲染
      plainMarkdown(text) {
        return String(text || "")
          .replace(/```[\s\S]*?```/g, " ")
          .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/<[^>]+>/g, " ")
          .replace(/^\s{0,3}#{1,6}\s+/gm, "")
          .replace(/^\s*[-*+]\s+/gm, "")
          .replace(/[*_`~>|]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      },
      noteTitle(note) {
        const content = (note && note.content) || "";
        const line = content.split(/\r?\n/).map(x => x.trim()).find(Boolean) || "";
        const title = this.plainMarkdown(line);
        return title ? title.slice(0, 60) : "未命名笔记";
      },
      notePreview(note) {
        const plain = this.plainMarkdown((note && note.content) || "");
        const title = this.noteTitle(note);
        const rest = plain.startsWith(title) ? plain.slice(title.length).trim() : plain;
        return rest.slice(0, 180);
      },
      // 概览提交时间按日历日显示（今天/昨天保留时分），与参考图的扫读方式一致；
      // 完整时间仍在 title 中原样可查。
      ovCommitTime(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        const now = new Date();
        const dayStart = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((dayStart(now) - dayStart(d)) / 86400000);
        const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        if (diff === 0) return `今天 ${hm}`;
        if (diff === 1) return `昨天 ${hm}`;
        if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
      },
      overviewAllCommits() { this.switchTab("records", "sec-commits"); },
      overviewAllNotes() { this.switchTab("records", "sec-notes"); },
      overviewNewNote() {
        this.switchTab("records", "sec-notes");
        this.openNoteDraft();
      },
      overviewAllLaunches() { this.switchTab("launch", "sec-launch"); },
      overviewEditDesc() { this.switchTab("records", "sec-desc"); },
      // 概览固定“仅本人”，不读取/重置开发记录里的作者筛选
      async loadRecentActivity() {
        if (!this.p) return;
        const pid = this.projectId;
        const rev = ++this.recentRevision;
        if (this.p.is_lost) {
          this.recentActivity = null;
          this.recentCommits = null;
          this.recentActivityLoading = false;
          this.recentCommitsLoading = false;
          this.recentActivityError = "";
          this.recentCommitsError = "";
          return;
        }
        this.recentActivityLoading = true;
        this.recentCommitsLoading = true;
        this.recentActivityError = "";
        this.recentCommitsError = "";
        const heat = api(`/api/projects/${pid}/heatmap?window_days=7&tz=local&authors=mine`,
          { silent: true })
          .then(r => {
            if (rev === this.recentRevision && pid === this.projectId) this.recentActivity = r;
          })
          .catch(e => {
            if (rev === this.recentRevision && pid === this.projectId) {
              this.recentActivity = null;
              this.recentActivityError = (e && e.message) || "读取失败";
            }
          })
          .finally(() => {
            if (rev === this.recentRevision && pid === this.projectId) {
              this.recentActivityLoading = false;
            }
          });
        // 多取一些再按提交时间排序，避免 git 提交图顺序与日期不一致时漏掉真正最近的 3 条
        const commits = api(`/api/projects/${pid}/commits?limit=20&authors=mine`,
          { silent: true })
          .then(r => {
            if (rev === this.recentRevision && pid === this.projectId) this.recentCommits = r;
          })
          .catch(e => {
            if (rev === this.recentRevision && pid === this.projectId) {
              this.recentCommits = null;
              this.recentCommitsError = (e && e.message) || "读取失败";
            }
          })
          .finally(() => {
            if (rev === this.recentRevision && pid === this.projectId) {
              this.recentCommitsLoading = false;
            }
          });
        await Promise.allSettled([heat, commits]);
      },
      // ---- 开发笔记 ----
      async loadNotes() {
        this.notesError = false;
        this.notesLoading = true;
        try {
          const r = await api(`/api/projects/${this.projectId}/notes`, { silent: true });
          this.notes = r.notes;
        } catch (e) { this.notes = []; this.notesError = true; }
        finally { this.notesLoading = false; }
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
        this.logsError = false;
        try {
          const r = await api(`/api/projects/${this.projectId}/changelogs`, { silent: true });
          this.changelogs = r.changelogs;
        } catch (e) { this.changelogs = []; this.logsError = true; }
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
        if (!await confirmDialog(`确定删除变更日志「${c.title || "未命名条目"}」吗？删除后不可恢复。`,
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
          this.shotsError = false;
        } catch (e) { this.screenshots = []; this.shotsError = true; }
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
        if (!await confirmDialog("确定删除这张截图吗？删除后不可恢复。",
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
        // 下载无页面反馈，先 toast 一声避免误以为没反应；失败由 downloadFile 报错
        toast("正在生成导出文件…", "ok");
        window.downloadFile(`/api/projects/${this.projectId}/export-html`,
          (this.p ? this.p.name : "project") + "-archive.html");
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
      // quiet=true：自动更新用，不显示骨架屏、不清空展开状态（局部替换，不闪烁）
      async loadCommitStats(quiet) {
        const revision = this.gitRevision;
        if (!quiet) this.commitStatsLoading = true;
        try {
          const result = await api(
            `/api/projects/${this.projectId}/commit-stats?authors=${this.commitAuthors}`, { silent: true });
          if (revision === this.gitRevision) this.commitStats = result;
        } catch (e) {
          if (revision === this.gitRevision) this.commitStats = null;
        } finally {
          if (revision === this.gitRevision) this.commitStatsLoading = false;
        }
      },
      async loadCommits(more, quiet) {
        const revision = this.gitRevision;
        if (more) this.commitLoadingMore = true;
        else if (!quiet) this.commitLoading = true;
        if (!more && !quiet) this.expandedCommits = [];
        try {
          const result = await api(
            `/api/projects/${this.projectId}/commits?limit=${this.commitLimit}&authors=${this.commitAuthors}`, { silent: true });
          if (revision === this.gitRevision) this.commitData = result;
        } catch (e) {
          if (revision === this.gitRevision) this.commitData = null;
        } finally {
          if (revision === this.gitRevision) {
            this.commitLoading = false;
            this.commitLoadingMore = false;
          }
        }
      },
      loadMoreCommits() {
        if (!this.hasMoreCommits || this.commitLoadingMore || this.commitLoading) return;
        this.commitLimit = Math.min(this.commitLimit + 50, 200);
        this.loadCommits(true);
      },
      firstLine(msg) { return ((msg || "").split("\n")[0] || "").slice(0, 120); },
      toggleTree() {
        if (this.treeOpen) this.closeTree();
        else this.openTree();
      },
      openTree() {
        if (!this.p || this.p.is_lost) return;
        this.treeOpen = true;
        try { localStorage.setItem("tl-tree-open", "1"); } catch (e) { /* 隐私模式 */ }
        if (this.tree === undefined) this.loadTree();
        this.$nextTick(() => {
          const btn = this.$refs.treeClose;
          if (btn && btn.focus) btn.focus();
        });
      },
      closeTree() {
        this.treeOpen = false;
        try { localStorage.setItem("tl-tree-open", "0"); } catch (e) { /* 隐私模式 */ }
      },
      // 月柱状图折叠（状态跨项目记忆）
      toggleMonthChart() {
        this.monthCollapsed = !this.monthCollapsed;
        localStorage.setItem("tl-month-collapsed", this.monthCollapsed ? "1" : "0");
      },
      toggleCommit(hash) {
        const i = this.expandedCommits.indexOf(hash);
        if (i >= 0) this.expandedCommits.splice(i, 1);
        else this.expandedCommits.push(hash);
      },
      // ---- 个人记录折叠区（项目描述 / 开发笔记 / 手写变更日志） ----
      setPersonalOpen(open) {
        this.personalOpen = open;
        localStorage.setItem("tl-personal-open", open ? "1" : "0");
      },
      togglePersonal() { this.setPersonalOpen(!this.personalOpen); },
      toggleRecord(key) { this.recordOpen[key] = !this.recordOpen[key]; },
      // 展开容器（可同时展开指定子块）：目录跳转与头部入口都走这里
      openRecord(key) {
        if (!this.personalOpen) this.setPersonalOpen(true);
        if (key) this.recordOpen[key] = true;
      },
      // 笔记入口：展开块 → 打开编辑器 → 聚焦（收起状态下一键开始写）
      openNoteDraft() {
        this.openRecord("notes");
        if (this.noteDraft === null) this.noteDraft = "";
        this.$nextTick(() => {
          const el = this.$refs.noteDraftEditor;
          if (el && el.focus) el.focus();
        });
      },
      // 变更日志入口：展开块 → 打开新增表单
      openLogEntry() {
        this.openRecord("logs");
        if (this.logDraft === null) this.openLogDraft();
      },
      // ---- 四分区与左侧页内锚点 ----
      anchorsForTab(tab) {
        return (TAB_ANCHORS[tab] || []).filter(a => this.anchorVisible(a.id));
      },
      anchorVisible(id) {
        if (id === "sec-readme") return !!(this.readme && this.readme.exists);
        if (id === "sec-flowchart") return !!(this.p && !this.p.is_lost);
        if (id === "sec-configs") return !!(this.meta && this.meta.configs && this.meta.configs.length);
        if (id === "sec-stats") return !!(this.meta && this.meta.stats);
        if (id === "sec-runs") return this.runs.length > 0 || this.runsError;
        if (id === "sec-launch") return !!(this.p && !this.p.is_lost);
        return true;
      },
      tabOfAnchor(id) { return ANCHOR_TAB[id] || null; },
      // 切分区：保存当前分区的阅读位置；目标分区用 v-show 保留全部已挂载内容
      switchTab(tab, anchor) {
        if (!DETAIL_TABS.some(t => t.key === tab)) return;
        const anchorId = typeof anchor === "string" ? anchor : "";
        if (tab === this.activeTab) {
          if (anchorId) this.scrollTo(anchorId);
          return;
        }
        this.sectionScroll[this.activeTab] = window.scrollY;
        this.activeTab = tab;
        const fallback = (this.anchorsForTab(tab)[0] || {}).id || "";
        const explicit = !!(anchorId && document.getElementById(anchorId));
        const target = explicit ? anchorId : fallback;
        this.activeSection = target;
        if (explicit) this.prepareAnchor(target);
        this.$nextTick(() => {
          if (explicit) this.scrollToElement(target);
          else window.scrollTo({ top: this.sectionScroll[tab] || 0, behavior: "auto" });
          this.spySuspendedUntil = Date.now() + 350;
        });
      },
      prepareAnchor(id) {
        if (id === "sec-desc") this.openRecord("desc");
        else if (id === "sec-notes") this.openRecord("notes");
        else if (id === "sec-changelogs") this.openRecord("logs");
        else if (id === "sec-personal") this.openRecord();
      },
      scrollToElement(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 1200);
      },
      scrollTo(id) {
        const tab = this.tabOfAnchor(id) || this.activeTab;
        if (tab !== this.activeTab) { this.switchTab(tab, id); return; }
        // 点击后锁定高亮，等平滑滚动结束再交还滚动监听
        this.activeSection = id;
        this.spySuspendedUntil = Date.now() + 1000;
        this.prepareAnchor(id);
        this.$nextTick(() => this.scrollToElement(id));
      },
      // 滚动监听：只统计当前分区真实可见的锚点
      onScroll() {
        if (Date.now() < (this.spySuspendedUntil || 0)) return;
        const anchors = this.activeAnchors;
        if (!anchors.length) return;
        const offset = 90;
        let current = anchors[0].id;
        for (const a of anchors) {
          const el = document.getElementById(a.id);
          if (el && el.getBoundingClientRect().top <= offset) current = a.id;
        }
        this.activeSection = current;
      },
      // 支持 /project/N#sec-commits 这类旧/外部锚点：先切分区再定位
      applyHashSection() {
        const hash = decodeURIComponent((location.hash || "").replace(/^#/, ""));
        if (!hash) return;
        const tab = this.tabOfAnchor(hash);
        if (!tab) return;
        this.$nextTick(() => {
          this.switchTab(tab, hash);
          setTimeout(() => this.scrollToElement(hash), 80);
        });
      },
      async loadReadme() {
        if (this.p.is_lost) { this.readme = { exists: false, variants: [] }; return; }
        // 带上本机记住的语言版本；该文件已不在根目录时后端自动回退主版本
        const pref = localStorage.getItem(README_LANG_KEY + this.projectId) || "";
        try {
          this.readme = await api(
            `/api/projects/${this.projectId}/readme` +
            (pref ? `?file=${encodeURIComponent(pref)}` : ""), { silent: true });
        } catch (e) {
          this.readme = { exists: false, variants: [] };
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
          toast(target === "vscode" ? `已在 ${window.editorName(this.editorCmd)} 中打开` : "已在资源管理器中打开", "ok");
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
            if (this.treeOpen) this.loadTree();
            this.loadCommits();
            this.loadRecentActivity();
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
          if (this.treeOpen) this.loadTree();
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
          // 标签栏常驻：改名 / 改别名后刷新标签的悬浮提示，避免显示旧值
          window.dispatchEvent(new Event("tl-project-updated"));
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
          toast("档案记录已删除；如误删，可在 设置 → 数据 中从自动备份恢复", "ok");
          const pid = this.projectId;
          setTimeout(() => {
            // 标签栏常驻，档案删了要同步摘掉标签，否则会留下点不开的死标签
            if (window.tlForgetTab) window.tlForgetTab(pid);
            window.tlSoftNavigate("/");
          }, 600);
        } catch (e) { /* toast 已提示 */ }
      },
    },
    mounted() {
      // 第一屏用库里的旧数据先渲染；渲染完再后台刷新采集数据（不阻塞、不闪烁）
      this.load().then(() => {
        if (!this._disposed && this.p) {
          this.recordVisit();
          this.applyHashSection();
          this.autoRefreshStart();
        }
      });
      // 回到前台：切窗口、最小化恢复都会触发；focus 与 visibilitychange 由去抖合并
      this._onVisible = () => {
        if (document.visibilityState === "visible") this.autoRefreshStart();
      };
      document.addEventListener("visibilitychange", this._onVisible);
      this._onFocus = () => this.autoRefreshStart();
      window.addEventListener("focus", this._onFocus);
      // 桌面壳（desktop.py）把窗口从最小化/托盘真正唤到前台后调用
      window.tlOnWindowResume = () => this.autoRefreshStart();
      // 顶部标签栏 / 其它共享组件的跳转统一走 tlNavigate，避免绕过「未保存内容」确认
      window.tlNavigate = (url) => this.leaveConfirm(url);
      window.addEventListener("scroll", this.onScroll, { passive: true });
      // 有未保存内容时的离开确认改用应用内弹窗（leaveConfirm），见 gotoSibling/返回首页：
      // 原生 beforeunload 在 pywebview(WebView2) 桌面壳里确认框可能不可见，导致「退不出来」。
      // Esc 依次关闭：文档查看器 → 设置弹窗 → 截图灯箱 → 启动表单 → 更多菜单 → 编辑弹窗
      this._onKey = (e) => {
        // 灯箱打开时 ←/→ 切图（与按钮 navShot 同一逻辑，键盘用户也能翻页）
        if (this.previewShot && e.key === "ArrowLeft") { this.navShot(-1); return; }
        if (this.previewShot && e.key === "ArrowRight") { this.navShot(1); return; }
        if (e.key !== "Escape") return;
        if (this.docView) { this.docView = null; return; }
        if (this.$refs.settings && this.$refs.settings.visible) { this.$refs.settings.close(); return; }
        if (this.flowZoom) { this.flowZoom = null; return; }
        if (this.previewShot) { this.previewShot = null; return; }
        if (this.showLaunchForm) { this.closeLaunchForm(); return; }
        if (this.launchMenuOpen) { this.launchMenuOpen = false; return; }
        if (this.moreOpen) { this.moreOpen = false; return; }
        if (this.showEdit) { this.showEdit = false; return; }
        if (this.treeOpen) this.closeTree();
      };
      document.addEventListener("keydown", this._onKey);
      // Markdown 区链接全局拦截（捕获阶段，先于默认跳转）
      this._onMdClick = (e) => this.onMdLinkClick(e);
      document.addEventListener("click", this._onMdClick, true);
    },
    beforeUnmount() {
      this._disposed = true;                    // 停止自动更新的轮询与回填
      clearTimeout(this._refreshTimer);
      document.removeEventListener("visibilitychange", this._onVisible);
      window.removeEventListener("focus", this._onFocus);
      window.tlOnWindowResume = null;
      window.removeEventListener("scroll", this.onScroll);
      document.removeEventListener("keydown", this._onKey);
      document.removeEventListener("click", this._onMdClick, true);
      this.stopRunPolling();   // 运行输出轮询定时器：离开页面必须清掉
    },
  });

  app.component("tree-node", TreeNode);
  app.component("tl-select", window.TlSelect);
  app.component("tl-icon", window.TlIcon);
  app.component("tl-tabbar", window.TlTabbar);
  app.component("tl-settings-dialog", window.TlSettingsDialog);
  app.directive("modal", window.TlModal);
  // 注入公共工具函数（fmtTime/copyText 等），供模板表达式调用
  Object.assign(app.config.globalProperties, window.TL_HELPERS);
  // 根实例挂在 window 上：桌面壳诊断、自动化验证（自动更新/草稿保护）都从这里取组件
  window.__tlProjectVM = app.mount("#app");
  // 软导航切换页面时要卸载本应用（见 common.js 的 softNavigate）：
  // beforeUnmount 里负责清掉滚动 / 键盘 / 全局点击监听与运行输出轮询
  window.__tlPageApp = app;
})();
