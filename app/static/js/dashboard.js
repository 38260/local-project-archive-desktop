/* 首页仪表盘：项目卡片、搜索筛选、手动录入、批量扫描 */
(function () {
  "use strict";
  const { createApp } = Vue;

  // 排序下拉：规则只做「一键整理」，拖动卡片随时覆盖排列（没有独立的手动排序模式）
  const SORT_LABELS = ["最近更新", "最近修改", "最近打开", "名称", "创建时间", "状态"];
  const SORT_KEYS = {
    "最近更新": "updated", "最近修改": "modified", "最近打开": "opened",
    "名称": "name", "创建时间": "created", "状态": "status",
  };
  const QUICK_VIEWS = { recent: "最近打开", pinned: "已置顶" };
  const NAV_SECTION_DEFS = [
    { key: "quick", label: "快捷导航" },
    { key: "status", label: "项目状态" },
    { key: "tags", label: "常用标签" },
  ];
  const NAV_SECTION_KEYS = NAV_SECTION_DEFS.map(s => s.key);
  const NAV_DEFAULT_SECTIONS = ["quick", "status", "tags"];
  // 侧栏演示顺序只用于导航呈现；卡片分组仍使用 STATUS_ORDER
  const NAV_DEFAULT_STATUSES = ["进行中", "暂停", "已完成", "归档", "废弃"];
  const NAV_SECTION_LABELS = Object.fromEntries(NAV_SECTION_DEFS.map(s => [s.key, s.label]));
  const validOpenAt = (iso) => {
    const t = Date.parse(iso || "");
    return Number.isNaN(t) ? null : t;
  };
  const STATUS_ORDER = ["进行中", "已完成", "暂停", "归档", "废弃"];

  const app = createApp({
      data() {
      return {
        loading: true,
        dataPath: "",
        appVersion: "",
        appPort: "",
        rescanningAll: false,
        rescanProgress: { done: 0, total: 0, ok: 0, failed: [] },
        toolsOpen: false,
        projects: [],
        stats: { total: 0, active: 0, archived: 0, discarded: 0, lost: 0 },
        statuses: [],
        themeTick: 0,
        nowTick: Date.now(),    // 每 60 秒推进：跨午夜后重算“今天/昨天”
        // 筛选
        q: "",
        statusFilter: "",
        tagFilter: "",
        catFilter: "",
        showDiscarded: false,   // 废弃项目默认隐藏，勾选后显示（归档始终展示）
        // 快捷视图：null=全部 | recent | pinned（导航用），active | lost（统计卡下钻）
        quickFilter: null,
        // 左侧导航：区域/状态/标签均可配置，保存在 ui.nav_* 设置里
        sidebarOpen: false,
        navSections: [...NAV_DEFAULT_SECTIONS],
        navStatuses: [...NAV_DEFAULT_STATUSES],
        navTags: [],
        showNavConfig: false,
        navSaving: false,
        navDraft: {
          sections: [...NAV_DEFAULT_SECTIONS],
          statuses: [...NAV_DEFAULT_STATUSES],
          tags: [],
        },
        sortBy: "最近更新",
        sortOptions: SORT_LABELS,
        projectOrder: [],
        orderSaving: false,
        dragProjectId: null,
        dropProjectId: null,
        // 首页总热力图（全部项目提交聚合）
        heat: null,
        heatRevision: 0,
        dayRevision: 0,
        heatWeeks: 53,
        // 折叠状态：**默认收起**，先把下面的项目列表露出来；用户手动展开后按本机偏好记住。
        // 存储语义取「已展开」而不是「已收起」——这样「没存过」天然等于收起，无需额外迁移；
        // 旧键 tl-home-heat-collapsed（默认展开时代的产物）就此废弃，不再读写。
        heatCollapsed: localStorage.getItem("tl-home-heat-expanded") !== "1",
        // 当日提交弹窗（点击热力图某天）
        showDay: false,
        dayLoading: false,
        dayData: null,
        // 打开项目的编辑器（设置联动：卡片按钮图标/文字跟随）
        editorCmd: "code",
        // 手动录入
        showAdd: false,
        submitting: false,
        form: this.emptyForm(),
        // 批量扫描
        showScan: false,
        scanning: false,
        importing: false,
        scanRoot: "",
        scanDepth: 3,
        candidates: null,
        scanProgress: null,     // 扫描后台任务进度快照（轮询 /api/scan/progress）
        importProgress: null,   // 导入后台任务进度快照（轮询 /api/scan/import/progress）
        importForm: { category: "" },
        // 通用设置键值（来自 /api/settings；设置弹窗本体在共享组件 js/settings.js）
        prefs: {},
        // 自动更新：进入首页 / 回到前台时后台批量刷新采集数据。
        // state: idle | running | done（短暂）| error（可重试）
        autoRefresh: { state: "idle", total: 0, done: 0, failed: 0, changed: 0, reason: "" },
      };
    },
    computed: {
      themeIcon() {
        this.themeTick; // 建立响应式依赖
        const p = window.themePref();
        return p === "auto" ? "monitor" : (p === "dark" ? "moon" : "sun");
      },
      themeLabel() {
        this.themeTick;
        return window.themeName();
      },
      currentThemePref() {
        this.themeTick;   // 建立响应式依赖
        return window.themePref();
      },
      editorName() {
        return window.editorName(this.editorCmd);
      },
      // 总热力图网格：days 为 {date: {count, names}}，取 count 出格子，names 进悬浮提示
      heatGrid() {
        if (!this.heat) return null;
        const flat = {};
        for (const [k, v] of Object.entries(this.heat.days || {})) {
          flat[k] = v.count;
        }
        const grid = window.buildHeatGrid(flat, this.heatWeeks);
        // 悬浮提示带上当天有提交的项目名
        for (const col of grid.cols) {
          for (const cell of col) {
            if (!cell) continue;
            const info = (this.heat.days || {})[cell.date];
            const names = (info && info.names) || [];
            cell.label = `${cell.date}：${cell.n} 次提交` + (names.length ? `（${names.join("、")}）` : "");
          }
        }
        return { ...grid, total: (this.heat.total || 0), repos: (this.heat.repos || 0) };
      },
      allTags() {
        const set = new Set();
        this.projects.forEach(p => (p.tags || []).forEach(t => set.add(t)));
        return [...set].sort((a, b) => a.localeCompare(b, "zh-CN"));
      },
      allCategories() {
        const set = new Set();
        this.projects.forEach(p => { if (p.category) set.add(p.category); });
        return [...set];
      },
      // 导航计数：排除本区域当前选择、保留其他区域条件，避免同区域其他项被归零。
      // 状态候选“废弃”显式计入废弃项目；其余状态仍遵循“显示废弃项目”开关。
      navCounts() {
        let all = 0, recent = 0, pinned = 0;
        for (const p of this.projects) {
          if (!this.navMatch(p, { ignoreQuick: true })) continue;
          all++;
          if (validOpenAt(p.last_opened_at) !== null) recent++;
          if (p.pinned) pinned++;
        }
        return { all, recent, pinned };
      },
      navStatusItems() {
        return this.navStatuses.map(status => ({
          status,
          count: this.projects.filter(p => this.navMatch(p, {
            ignoreStatus: true, statusCandidate: status,
          })).length,
        }));
      },
      navTagItems() {
        return this.navTags.map(tag => ({
          tag,
          count: this.projects.filter(p => this.navMatch(p, {
            ignoreTag: true, tagCandidate: tag,
          })).length,
        }));
      },
      navDraftSectionItems() {
        return this.navDraft.sections.map(key => ({
          key, label: NAV_SECTION_LABELS[key] || key,
        }));
      },
      hiddenNavSections() {
        return NAV_SECTION_DEFS.filter(s => !this.navDraft.sections.includes(s.key));
      },
      availableStatuses() {
        return STATUS_ORDER.filter(s => !this.navDraft.statuses.includes(s));
      },
      availableTagNames() {
        return this.allTags.filter(t => !this.navDraft.tags.includes(t));
      },
      sorted() {
        const key = SORT_KEYS[this.sortBy] || "updated";
        const byTime = (f) => (a, b) => String(b[f] || "").localeCompare(String(a[f] || ""));
        const openedAt = (p) => {
          const t = validOpenAt(p.last_opened_at);
          return t === null ? -Infinity : t;
        };
        // 最近打开：有记录在前、时间倒序；同一时刻按 id 稳定兜底，空记录永远在后
        const cmpOpened = (a, b) => (openedAt(b) - openedAt(a)) || (a.id - b.id);
        const cmp = {
          updated: byTime("updated_at"),
          modified: byTime("fs_modified"),
          opened: cmpOpened,
          created: byTime("created_at"),
          name: (a, b) => a.name.localeCompare(b.name, "zh-CN"),
          status: (a, b) => (STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
                            || byTime("updated_at")(a, b),
        }[key];
        // 最近打开是派生临时视图：同状态组内固定按访问时间倒序，
        // 不读取也不改写用户保存的手动顺序；置顶仍优先。
        if (this.quickFilter === "recent") {
          return this.projects.slice().sort(
            (a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
              || cmpOpened(a, b));
        }
        // 置顶优先 → 拖动过的项目按保存的顺序 → 其余按所选规则。
        // 顺序只影响**同状态组内**的先后（展示永远按状态分组，见 displayGroups）；
        // 顺序里没有的项目（新增导入）落在组内末尾，不打乱已拖好的相对位置。
        const positions = new Map(this.projectOrder.map((id, index) => [id, index]));
        return this.projects.slice().sort(
          (a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
            || ((positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity))
            || cmp(a, b));
      },
      filtered() {
        return this.sorted.filter(p => this.navMatch(p));
      },
      // 已生效的筛选条件，逐个可移除
      activeFilters() {
        const f = [];
        if (this.q) f.push({ k: "q", label: "搜索：" + this.q, clear: () => { this.q = ""; } });
        if (this.statusFilter) f.push({ k: "status", label: "状态：" + this.statusFilter, clear: () => { this.statusFilter = ""; } });
        if (this.tagFilter) f.push({ k: "tag", label: "标签：" + this.tagFilter, clear: () => { this.tagFilter = ""; } });
        if (this.catFilter) f.push({ k: "cat", label: "分类：" + this.catFilter, clear: () => { this.catFilter = ""; } });
        if (this.quickFilter === "active") f.push({ k: "qf", label: "仅活跃", clear: () => { this.quickFilter = null; } });
        if (this.quickFilter === "lost") f.push({ k: "qf", label: "仅路径丢失", clear: () => { this.quickFilter = null; } });
        if (QUICK_VIEWS[this.quickFilter]) f.push({
          k: "qf", label: QUICK_VIEWS[this.quickFilter],
          clear: () => { this.quickFilter = null; },
        });
        if (this.showDiscarded) f.push({ k: "arch", label: "含废弃项目", clear: () => { this.showDiscarded = false; } });
        return f;
      },
      checkedCount() {
        return this.candidates ? this.candidates.candidates.filter(c => c.checked).length : 0;
      },
      // 永远保留状态分组；有搜索或筛选时合成单个"搜索结果"组（平铺）。
      // 最近打开/已置顶是临时导航视图：继续保留状态分组，便于和普通列表对照。
      dragLocked() {
        return this.orderSaving || this.quickFilter === "recent";
      },
      todayLabel() {
        this.nowTick;
        const d = new Date();
        const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
        return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
      },
      displayGroups() {
        const quickGrouped = this.quickFilter === "recent" || this.quickFilter === "pinned";
        if (!quickGrouped
            && (this.q || this.statusFilter || this.tagFilter || this.catFilter || this.quickFilter)) {
          return [{ status: "搜索结果", items: this.filtered }];
        }
        const map = {};
        for (const p of this.filtered) {
          (map[p.status] = map[p.status] || []).push(p);
        }
        return STATUS_ORDER.filter(s => map[s]).map(s => ({ status: s, items: map[s] }));
      },
    },
    methods: {
      emptyForm() {
        return { path: "", name: "", alias: "", category: "", status: "进行中", tagsText: "" };
      },
      async load() {
        this.loading = true;
        try {
          const data = await api("/api/projects");
          this.projects = data.projects;
          this.stats = data.stats;
          this.statuses = data.statuses;
        } finally {
          this.loading = false;
        }
        await this.loadPrefs();
        this.loadHeatmap();
      },
      // ---- 自动更新（进入首页 / 回到前台）----
      // 首屏先用库里的数据渲染；后台把已收录项目排进一个刷新任务，完成后只替换
      // projects / stats 与热力图，搜索、筛选、拖动顺序、滚动位置都不动。
      autoRefreshStart(force) {
        if (this._disposed) return;
        clearTimeout(this._arTimer);
        // focus 与 visibilitychange 常同时触发，合并成一次（服务端还有 30s 冷却兜底）
        this._arTimer = setTimeout(() => this.runAutoRefresh(!!force), force ? 0 : 400);
      },
      async runAutoRefresh(force) {
        if (this._disposed || this._arBusy) return;
        const ids = this.projects.map(p => p.id).filter(Boolean).slice(0, 500);
        if (!ids.length) return;
        this._arBusy = true;
        // 记录刷新前的滚动位置：列表/热力图都可能因数据变化改变高度
        const y = window.scrollY;
        Object.assign(this.autoRefresh,
          { state: "running", total: ids.length, done: 0, failed: 0, changed: 0, reason: "" });
        try {
          const r = await api("/api/refresh", {
            method: "POST", body: { ids, force: !!force }, silent: true,
          });
          if (this._disposed) return;
          if (!r || !r.job_id) {        // 全部在冷却中（刚刷新过）：静默
            this.autoRefresh.state = "idle";
            return;
          }
          this.autoRefresh.total = r.total || ids.length;
          const job = await this.pollRefreshJob(r.job_id);
          if (this._disposed) return;
          if (!job) throw new Error("刷新任务超时");
          this.autoRefresh.done = job.done;
          this.autoRefresh.total = job.total;
          this.autoRefresh.failed = (job.failed || []).length;
          this.autoRefresh.changed = (job.changed_ids || []).length;
          // 有项目真的变了才重拉列表与热力图（避免无意义的整页重绘）
          if (job.ok > 0) await this.refreshListQuiet();
          if (this.autoRefresh.changed > 0) await this.loadHeatmap();
          // 卡片/热力图高度变化会触发浏览器滚动锚定，统一拉回刷新前的位置
          this.restoreScroll(y);
          this.autoRefresh.state = "done";
          setTimeout(() => {
            if (!this._disposed && this.autoRefresh.state === "done") this.autoRefresh.state = "idle";
          }, 2500);
        } catch (e) {
          if (!this._disposed) {
            this.autoRefresh.state = "error";
            const raw = (e && e.message) || "";
            this.autoRefresh.reason = /Failed to fetch|NetworkError|Load failed/i.test(raw)
              ? "无法连接本地服务，请确认程序仍在运行"
              : (raw || "刷新失败");
          }
        } finally {
          this._arBusy = false;
        }
      },
      async pollRefreshJob(jobId) {
        // 首页是批量任务（项目多时耗时自然长），给 3 分钟上限；进度实时回填
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 800));
          if (this._disposed) return null;
          try {
            const j = await api(`/api/refresh/${jobId}`, { silent: true });
            if (this._disposed) return null;
            this.autoRefresh.done = j.done;
            this.autoRefresh.total = j.total;
            if (j.state === "done") return j;
          } catch (e) {
            if (e.status === 404) return null;
          }
        }
        return null;
      },
      // 静默替换列表数据：不进入 loading（不闪骨架屏），保持所有筛选/排序状态
      async refreshListQuiet() {
        const data = await api("/api/projects", { silent: true });
        if (this._disposed) return;
        this.projects = data.projects;
        this.stats = data.stats;
        this.statuses = data.statuses;
        await this.$nextTick();
      },
      // 把滚动位置拉回刷新前：先关掉滚动锚定，再在下一帧/稍后各校正一次，
      // 避免数据替换 + 热力图重排把用户正在看的位置顶走
      restoreScroll(y) {
        const root = document.documentElement;
        const prev = root.style.overflowAnchor;
        root.style.overflowAnchor = "none";
        window.scrollTo(0, y);
        requestAnimationFrame(() => {
          window.scrollTo(0, y);
          setTimeout(() => {
            window.scrollTo(0, y);
            root.style.overflowAnchor = prev;
          }, 80);
        });
      },
      // 走统一出口（common.js 的软导航）：同文档切换，不整页重载
      goto(p) { window.tlNavigate("/project/" + p.id); },
      // 本地日历日差：今天/昨天按日历而不是 24 小时判断；跨午夜由 nowTick 驱动重算
      openAgeInfo(iso, nowMs) {
        this.nowTick;   // 建立响应式依赖
        const empty = { text: "尚无打开记录", title: "尚无打开记录", empty: true };
        if (!iso) return empty;
        const d = new Date(iso);
        const now = new Date(nowMs == null ? Date.now() : nowMs);
        if (Number.isNaN(d.getTime())) return { ...empty, title: "打开时间无效" };
        const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((dayStart(now) - dayStart(d)) / 86400000);
        let text;
        if (diff === 0) text = "今天";
        else if (diff === 1) text = "昨天";
        else if (diff > 1) text = `${diff} 天前`;
        else text = "刚刚";
        return { text, title: "上次打开：" + fmtTime(iso), empty: false };
      },
      openAgeText(iso) { return this.openAgeInfo(iso).text; },
      openAgeTitle(iso) { return this.openAgeInfo(iso).title; },
      toggleQuick(kind) {
        this.quickFilter = this.quickFilter === kind ? null : kind;
        this.sidebarOpen = false;
        window.scrollTo({ top: 0, behavior: "smooth" });
      },
      showAllProjects() {
        this.quickFilter = null;
        this.sidebarOpen = false;
        window.scrollTo({ top: 0, behavior: "smooth" });
      },
      // 单一匹配入口：导航计数与卡片列表共用，保证“数字 = 点击后的结果”。
      // 计算某区域候选时传 ignoreXxx，保留其他区域条件、排除本区域当前选择。
      navMatch(p, opts = {}) {
        if (this.catFilter && p.category !== this.catFilter) return false;
        // 废弃默认隐藏；显式选择“废弃”状态或状态候选是废弃时可见
        if (!this.showDiscarded && p.status === "废弃") {
          const explicit = opts.statusCandidate === "废弃" || this.statusFilter === "废弃";
          if (!explicit) return false;
        }
        if (opts.statusCandidate && p.status !== opts.statusCandidate) return false;
        if (opts.tagCandidate && !(p.tags || []).includes(opts.tagCandidate)) return false;
        if (!opts.ignoreStatus && this.statusFilter && p.status !== this.statusFilter) return false;
        if (!opts.ignoreTag && this.tagFilter && !(p.tags || []).includes(this.tagFilter)) return false;
        if (!opts.ignoreQuick && this.quickFilter) {
          if (this.quickFilter === "recent" && validOpenAt(p.last_opened_at) === null) return false;
          if (this.quickFilter === "pinned" && !p.pinned) return false;
          if (this.quickFilter === "active"
              && (p.status === "归档" || p.status === "废弃" || p.is_lost)) return false;
          if (this.quickFilter === "lost" && !p.is_lost) return false;
        }
        const q = this.q.toLowerCase();
        if (q) {
          const hay = [p.name, p.alias, p.path, p.category, (p.tags || []).join(",")]
            .join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      },
      // 同区域单选：再次点击当前条件取消
      toggleStatus(status) {
        this.statusFilter = this.statusFilter === status ? "" : status;
        this.sidebarOpen = false;
        window.scrollTo({ top: 0, behavior: "smooth" });
      },
      toggleTag(tag) {
        this.tagFilter = this.tagFilter === tag ? "" : tag;
        this.sidebarOpen = false;
        window.scrollTo({ top: 0, behavior: "smooth" });
      },
      // ---- 管理导航 ----
      navSectionLabel(key) { return NAV_SECTION_LABELS[key] || key; },
      openNavConfig() {
        this.navDraft = {
          sections: [...this.navSections],
          statuses: [...this.navStatuses],
          tags: [...this.navTags],
        };
        this.sidebarOpen = false;
        this.showNavConfig = true;
      },
      closeNavConfig() {
        if (!this.navSaving) this.showNavConfig = false;
      },
      applyNavTemplate(kind) {
        const presets = {
          both: ["quick", "status", "tags"],
          status: ["quick", "status"],
          tags: ["quick", "tags"],
        };
        this.navDraft.sections = [...(presets[kind] || presets.both)];
      },
      addDraftItem(kind, key) {
        const list = this.navDraft[kind];
        if (Array.isArray(list) && !list.includes(key)) list.push(key);
      },
      removeDraftItem(kind, key) {
        const list = this.navDraft[kind];
        if (!Array.isArray(list)) return;
        const i = list.indexOf(key);
        if (i >= 0) list.splice(i, 1);
      },
      moveDraftItem(kind, key, direction) {
        const list = this.navDraft[kind];
        if (!Array.isArray(list)) return;
        const i = list.indexOf(key);
        const j = i + direction;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
      },
      async saveNavConfig() {
        if (this.navSaving) return;
        this.navSaving = true;
        const payload = {
          "ui.nav_sections": [...this.navDraft.sections],
          "ui.nav_statuses": [...this.navDraft.statuses],
          "ui.nav_tags": [...this.navDraft.tags],
        };
        try {
          await api("/api/settings", { method: "PUT", body: payload });
          this.navSections = [...payload["ui.nav_sections"]];
          this.navStatuses = [...payload["ui.nav_statuses"]];
          this.navTags = [...payload["ui.nav_tags"]];
          this.showNavConfig = false;
          toast("导航配置已保存", "ok");
        } catch (e) { /* toast 已提示，保留草稿供修改 */ }
        finally { this.navSaving = false; }
      },
      // 选择整理规则：立即按规则重排并清掉旧的拖动顺序（重新整理后再拖可随时覆盖）。
      async saveSort(value) {
        if (this.orderSaving) return;
        const previous = this.sortBy;
        const previousOrder = this.projectOrder;
        this.sortBy = value;
        this.projectOrder = [];
        this.orderSaving = true;
        try {
          await api("/api/settings", { method: "PUT", body: {
            "ui.project_sort": value, "ui.project_order": [],
          } });
        } catch (e) {
          this.sortBy = previous;
          this.projectOrder = previousOrder;
        }
        finally { this.orderSaving = false; }
      },
      onProjectDragStart(p, ev) {
        // 最近打开视图按访问时间派生，拖动会改写普通列表的手动顺序，因此暂停
        if (this.dragLocked) { ev.preventDefault(); return; }
        this.dragProjectId = p.id;
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", String(p.id));
      },
      onProjectDragOver(p, ev) {
        const source = this.projects.find(item => item.id === this.dragProjectId);
        // 只允许同状态组内移动（含置顶边界）：跨组拖动不改分类/状态，
        // 搜索结果平铺视图里同样不允许跨状态换位
        if (!source || source.id === p.id
            || source.status !== p.status || !!source.pinned !== !!p.pinned) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        this.dropProjectId = p.id;
      },
      onProjectDragEnd() { this.dragProjectId = null; this.dropProjectId = null; },
      async onProjectDrop(p, ev) {
        const id = this.dragProjectId;
        const rect = ev.currentTarget.getBoundingClientRect();
        this.onProjectDragEnd();
        await this.moveProject(id, p.id, ev.clientX >= rect.left + rect.width / 2);
      },
      moveProjectByKey(p, direction) {
        if (this.dragLocked) return;
        // 同状态 + 同置顶边界内的相邻项（组内移动）
        const items = this.filtered.filter(item =>
          item.status === p.status && !!item.pinned === !!p.pinned);
        const target = items[items.findIndex(item => item.id === p.id) + direction];
        if (target) return this.moveProject(p.id, target.id, direction > 0);
      },
      async moveProject(id, targetId, after) {
        if (this.dragLocked || id === targetId) return;
        const source = this.projects.find(p => p.id === id);
        const target = this.projects.find(p => p.id === targetId);
        if (!source || !target
            || source.status !== target.status
            || !!source.pinned !== !!target.pinned) return;
        // 从完整列表移动（跨状态按展示分组还原），筛选隐藏的项目仍保留在顺序中：
        // 顺序只决定组内先后，跨状态部分怎么排不影响分组展示
        const all = STATUS_ORDER.flatMap(status => this.sorted.filter(p => p.status === status));
        const order = all.map(p => p.id).filter(key => key !== id);
        order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, id);
        const previousOrder = this.projectOrder;
        this.projectOrder = order;
        this.orderSaving = true;
        try {
          await api("/api/settings", { method: "PUT", body: { "ui.project_order": order } });
          toast("项目顺序已保存", "ok");
        } catch (e) {
          this.projectOrder = previousOrder;
          toast("顺序保存失败，已恢复原顺序", "error");
        } finally { this.orderSaving = false; }
      },
      switchTheme() { window.cycleTheme(); this.themeTick++; },
      chooseTheme(v) { window.setThemePref(v); this.themeTick++; },
      statActive(kind) {
        if (kind === "total") return !this.quickFilter && !this.statusFilter && this.showDiscarded;
        if (kind === "active") return this.quickFilter === "active";
        if (kind === "archived") return this.statusFilter === "归档";
        if (kind === "discarded") return this.statusFilter === "废弃";
        if (kind === "lost") return this.quickFilter === "lost";
        return false;
      },
      // 统计卡下钻：把数字变成筛选条件
      applyStatFilter(kind) {
        const already = this.statActive(kind);
        this.clearFilters();
        if (already) return; // 再次点击 = 取消下钻，回到默认视图
        if (kind === "total") this.showDiscarded = true;
        else if (kind === "active") this.quickFilter = "active";
        else if (kind === "archived") this.statusFilter = "归档";
        else if (kind === "discarded") { this.statusFilter = "废弃"; this.showDiscarded = true; }
        else if (kind === "lost") { this.quickFilter = "lost"; this.showDiscarded = true; }
        window.scrollTo({ top: 0, behavior: "smooth" });
      },
      clearFilters() {
        this.q = "";
        this.statusFilter = "";
        this.tagFilter = "";
        this.catFilter = "";
        this.quickFilter = null;
        this.showDiscarded = false;
      },
      async quickOpen(p, target) {
        try {
          await api(`/api/projects/${p.id}/open`, { method: "POST", body: { target } });
          toast(target === "vscode" ? `已在 ${this.editorName()} 打开` : "已在资源管理器打开", "ok");
        } catch (e) { /* toast 已提示 */ }
      },
      async togglePin(p) {
        try {
          const r = await api(`/api/projects/${p.id}/pin`, { method: "POST" });
          p.pinned = r.pinned;
          toast(r.pinned ? `已置顶「${p.name}」` : `已取消置顶「${p.name}」`, "ok");
        } catch (e) { /* toast 已提示 */ }
      },
      exportJson() {
        toast("正在生成导出文件…", "ok");
        window.downloadFile("/api/export", "tracelight-backup.json");
      },
      // 原生「选择文件夹」对话框（仅桌面窗口模式有 pywebview 桥）
      async browseFolder(target) {
        const bridge = window.pywebview && window.pywebview.api;
        if (!bridge) {
          toast("浏览器模式下不支持文件夹选择，请直接粘贴路径", "error");
          return;
        }
        try {
          const dir = await bridge.select_folder();
          if (!dir) return;
          // target 支持 "form.path" 这类点路径：逐层定位后再赋值
          // （this["form.path"] = dir 只会创建同名新属性，输入框不会更新）
          const seg = target.split(".");
          const leaf = seg.pop();
          let obj = this;
          for (const s of seg) obj = obj[s];
          obj[leaf] = dir;
        } catch (e) {
          toast("选择文件夹失败：" + (e.message || e), "error");
        }
      },
      // 后台任务 + 轮询进度，避免一个长请求卡住界面
      async rescanAll() {
        if (!this.projects.length) { toast("暂无项目可解析", "error"); return; }
        if (!await confirmDialog(
          `用最新解析器重新解析全部 ${this.projects.length} 个项目？\n已有标签会保留，新识别的技术栈会补充进来。`,
          { title: "全部重新解析", okText: "开始解析" })) return;
        this.rescanningAll = true;
        this.rescanProgress = { done: 0, total: this.projects.length, ok: 0, failed: [] };
        try {
          const r = await api("/api/projects/rescan-all", { method: "POST" });
          if (r.started === false) {
            toast("已有重新解析任务在进行中", "error");
            this.rescanningAll = false;
            return;
          }
          this.pollRescan();
        } catch (e) { this.rescanningAll = false; }
      },
      async pollRescan() {
        // 进度文案/按钮禁用态由 rescanningAll 维持：仅在轮询真正结束时复位。
        // 原先 finally 无条件复位，running 中提前 return 的那次也复位，
        // 导致「解析中 x/y」一闪即没、按钮提前恢复可点。
        let keepPolling = false;
        try {
          const p = await api("/api/projects/rescan-all/progress", { silent: true });
          this.rescanProgress = p;
          if (p.running) {
            keepPolling = true;
            setTimeout(() => this.pollRescan(), 800);
            return;
          }
          let msg = `已重新解析 ${p.ok} 个项目`;
          if (p.failed && p.failed.length) {
            msg += `，${p.failed.length} 个失败：${p.failed[0].name}（${p.failed[0].reason}）`;
          }
          toast(msg, p.failed && p.failed.length ? "error" : "ok");
          this.load();
        } catch (e) { /* toast 已提示 */ }
        finally { if (!keepPolling) this.rescanningAll = false; }
      },

      async loadPrefs() {
        try {
          this.prefs = await api("/api/settings", { silent: true });
          this.projectOrder = Array.isArray(this.prefs["ui.project_order"])
            ? this.prefs["ui.project_order"].filter(id => Number.isSafeInteger(id) && id > 0) : [];
          this.sortBy = SORT_LABELS.includes(this.prefs["ui.project_sort"])
            ? this.prefs["ui.project_sort"] : "最近更新";
          this.editorCmd = this.prefs["editor.command"] || "code";
          // 旧设置没有导航键时用默认值；键存在但内容损坏时也安全回退。
          // 空数组是用户主动“全部隐藏”的合法配置，不能当成缺失。
          const rawSections = this.prefs["ui.nav_sections"];
          if (Array.isArray(rawSections)) {
            const list = [];
            for (const key of rawSections) {
              if (NAV_SECTION_KEYS.includes(key) && !list.includes(key)) list.push(key);
            }
            this.navSections = list.length ? list
              : (rawSections.length ? [...NAV_DEFAULT_SECTIONS] : []);
          } else {
            this.navSections = [...NAV_DEFAULT_SECTIONS];
          }
          const rawStatuses = this.prefs["ui.nav_statuses"];
          if (Array.isArray(rawStatuses)) {
            const list = [];
            for (const status of rawStatuses) {
              if (STATUS_ORDER.includes(status) && !list.includes(status)) list.push(status);
            }
            this.navStatuses = list.length ? list
              : (rawStatuses.length ? [...NAV_DEFAULT_STATUSES] : []);
          } else {
            this.navStatuses = [...NAV_DEFAULT_STATUSES];
          }
          const rawTags = this.prefs["ui.nav_tags"];
          const tagList = [];
          if (Array.isArray(rawTags)) {
            for (const item of rawTags) {
              if (typeof item !== "string") continue;
              const name = item.trim();
              if (!name || tagList.includes(name)) continue;
              tagList.push(name);
              if (tagList.length >= 100) break;
            }
          }
          this.navTags = tagList;
          const w = Number(this.prefs["ui.heatmap_weeks"]);
          if (w && w !== this.heatWeeks) {
            this.heatWeeks = w;
            this.loadHeatmap();   // 热力图范围变化即时重载
          }
        } catch (e) { this.prefs = {}; }
      },
      // 首页总热力图：全部 git 项目按天提交聚合
      async loadHeatmap() {
        const revision = ++this.heatRevision;
        try {
          const result = await api(`/api/heatmap?weeks=${this.heatWeeks}`, { silent: true });
          if (revision === this.heatRevision) this.heat = result;
        } catch (e) { if (revision === this.heatRevision) this.heat = null; }
      },
      toggleHeat() {
        this.heatCollapsed = !this.heatCollapsed;
        // 记「已展开」，与上面的读取口径保持一致（没存过 = 收起）
        localStorage.setItem("tl-home-heat-expanded", this.heatCollapsed ? "0" : "1");
      },
      // 点击热力图某天：弹窗展示该日全部项目的提交明细
      openDayDetail(cell) {
        if (!cell || !cell.n) return;   // 无提交的日子不可点
        const revision = ++this.dayRevision;
        this.showDay = true;
        this.dayData = null;
        this.dayLoading = true;
        api(`/api/day-commits?date=${cell.date}`, { silent: true })
          .then(d => { if (revision === this.dayRevision) this.dayData = d; })
          .catch(() => { if (revision === this.dayRevision) this.showDay = false; /* toast 已提示 */ })
          .finally(() => { if (revision === this.dayRevision) this.dayLoading = false; });
      },
      closeDay() { this.dayRevision++; this.showDay = false; this.dayData = null; this.dayLoading = false; },
      // ---- 设置（共享弹窗，见 js/settings.js） ----
      openSettings() { this.$refs.settings.open(); },
      // 设置变更联动：prefs=刷新编辑器按钮/主题/热力图范围等联动状态；
      // data=数据被导入/恢复/清空，整页重新加载
      onSettingsChanged(kind, key, value) {
        this.themeTick++;
        if (key === "ui.show_discarded_default") this.showDiscarded = !!value;
        this.loadPrefs();
        if (key === "git.author_emails") {
          this.closeDay();
          this.loadHeatmap();
        }
        if (kind === "data") this.load();
      },
      async openDataFolder() {
        try {
          const r = await api("/api/settings/open-data-folder");
          toast("已打开数据文件夹", "ok");
          this.dataPath = r.path || this.dataPath;
        } catch (e) { /* toast 已提示 */ }
      },

      // ---- 手动录入 ----
      async openAdd() {
        this.form = this.emptyForm();
        // 应用设置里的默认状态/分类
        if (!this.prefs || !Object.keys(this.prefs).length) await this.loadPrefs();
        const ds = this.prefs["add.default_status"];
        if (ds && this.statuses.includes(ds)) this.form.status = ds;
        this.form.category = this.prefs["add.default_category"] || "";
        this.showAdd = true;
      },
      async submitAdd() {
        if (!this.form.path) { toast("请填写项目路径", "error"); return; }
        if (this.submitting) return;
        this.submitting = true;
        try {
          await this._doSubmit(false);
        } finally { this.submitting = false; }
      },
      // force=false 先正常提交；命中疑似重复（409 + duplicates）时弹确认，
      // 用户确认后带 force 重发（后端允许强制录入，产生重复档案是用户显式选择）
      async _doSubmit(force) {
        try {
          const p = await api("/api/projects", {
            method: "POST",
            body: {
              path: this.form.path,
              name: this.form.name || null,
              alias: this.form.alias,
              category: this.form.category,
              status: this.form.status,
              tags: this.form.tagsText.split(/[,，;；]/).map(s => s.trim()).filter(Boolean),
              force,
            },
          });
          toast(`「${p.name}」录入成功，已解析 ${p.auto_meta.configs.length} 个配置文件`, "ok");
          this.showAdd = false;
          this.load();
        } catch (e) {
          const d = e.data && e.data.detail;
          const dups = e.status === 409 && d && Array.isArray(d.duplicates) ? d.duplicates : null;
          if (dups && !force) {
            const lines = dups.slice(0, 4).map(x =>
              `·「${x.name}」（${dupReasonText(x.reasons)}）：${shortPath(x.path, 64)}`);
            if (dups.length > 4) lines.push(`…等共 ${dups.length} 条`);
            const ok = await confirmDialog(
              `档案库中已有疑似同一项目：\n${lines.join("\n")}\n\n仍然录入将产生重复档案。`,
              { title: "疑似重复项目", okText: "仍然录入", danger: true });
            if (ok) return this._doSubmit(true);
          }
        }
      },

      // ---- 批量扫描 ----
      async openScan() {
        this.showScan = true;
        this.candidates = null;
        // 用设置里的默认深度与上次扫描目录，省去每次重填
        if (!this.prefs || !Object.keys(this.prefs).length) await this.loadPrefs();
        this.scanDepth = Math.min(6, Math.max(1, Number(this.prefs["scan.default_depth"]) || 3));
        this.scanRoot = this.prefs["scan.last_root"] || "";
        this.importForm.category = this.prefs["add.default_category"] || "";
        this.$nextTick(() => this.$refs.scanRootInput && this.$refs.scanRootInput.focus());
      },
      closeScan() { this.showScan = false; this.candidates = null; },
      async doScan() {
        if (!this.scanRoot) { toast("请填写扫描根目录", "error"); return; }
        this.scanning = true;
        this.scanProgress = null;
        try {
          const r = await api("/api/scan", {
            method: "POST",
            body: { root: this.scanRoot, max_depth: this.scanDepth },
          });
          if (r.started === false) {
            toast(r.reason || "已有扫描任务在进行中", "error");
            this.scanning = false;
            return;
          }
          // 记住本次扫描目录，下次打开直接用
          api("/api/settings", {
            method: "PUT", body: { "scan.last_root": this.scanRoot }, silent: true,
          }).catch(() => {});
          this.pollScan();
        } catch (e) { this.scanning = false; }
      },
      // 扫描是后台任务：轮询进度接口，期间展示已遍历目录数
      async pollScan() {
        try {
          const p = await api("/api/scan/progress", { silent: true });
          this.scanProgress = p;
          if (p.running) {
            setTimeout(() => this.pollScan(), 500);
            return;
          }
          if (p.error) { toast(p.error, "error"); return; }
          // 已导入 / 疑似重复的默认不勾选；疑似重复可手动勾选，导入时会再提示
          p.candidates.forEach(c => { c.checked = !c.imported && !c.dup; });
          this.candidates = { root: p.root, candidates: p.candidates,
                              scanned_dirs: p.scanned_dirs, truncated: p.truncated };
          if (!p.candidates.length) toast("未发现候选项目", "ok");
        } catch (e) { /* toast 已提示 */ }
        finally { this.scanning = false; }
      },
      async doImport() {
        // 疑似重复（同名/同 Git 远端）的候选：默认不导入，确认后只导其余；
        // 如确需重复存档，取消后用「手动录入」并确认强制录入
        const dups = this.candidates.candidates.filter(c => c.checked && c.dup && !c.imported);
        if (dups.length) {
          const lines = dups.slice(0, 5).map(c =>
            `· ${c.name}（${dupReasonText(c.dup.reasons)}于「${c.dup.name}」）`);
          if (dups.length > 5) lines.push(`…等共 ${dups.length} 个`);
          const ok = await confirmDialog(
            `以下候选与已有档案疑似同一项目，将跳过不导入：\n${lines.join("\n")}\n\n其余选中项目正常导入。`,
            { title: "疑似重复项目", okText: "跳过并导入其余", cancelText: "返回修改" });
          if (!ok) return;
        }
        const paths = this.candidates.candidates
          .filter(c => c.checked && (!c.dup || c.imported)).map(c => c.path);
        if (!paths.length) return;
        this.importing = true;
        this.importProgress = null;
        try {
          const r = await api("/api/scan/import", {
            method: "POST",
            body: { paths, category: this.importForm.category, status: "进行中", tags: [] },
          });
          if (r.started === false) {
            toast(r.reason || "已有导入任务在进行中", "error");
            this.importing = false;
            return;
          }
          this.pollImport();
        } catch (e) { this.importing = false; }
      },
      // 导入是后台任务：解析 4 路并发，轮询展示完成数
      async pollImport() {
        try {
          const p = await api("/api/scan/import/progress", { silent: true });
          this.importProgress = p;
          if (p.running) {
            setTimeout(() => this.pollImport(), 500);
            return;
          }
          let msg = `导入 ${p.imported} 个项目，跳过 ${p.skipped} 个已存在`;
          if (p.duplicates && p.duplicates.length) {
            msg += `（其中 ${p.duplicates.length} 个疑似重复：${dupReasonText(p.duplicates[0].reasons)}）`;
          }
          if (p.failed.length) msg += `，失败 ${p.failed.length} 个：${p.failed[0].path}（${p.failed[0].reason}）`;
          toast(msg, p.failed.length ? "error" : "ok");
          this.closeScan();
          this.load();
        } catch (e) { /* toast 已提示 */ }
        finally { this.importing = false; }
      },
    },
    mounted() {
      // 首屏先渲染库里的旧数据；之后后台批量更新（不阻塞、不闪骨架屏）
      this.load().then(() => {
        if (!this._disposed && this.projects.length) this.autoRefreshStart();
      });
      // 回到前台：切窗口、最小化恢复；桌面壳恢复也会调 tlOnWindowResume
      this._onVisible = () => {
        if (document.visibilityState === "visible") {
          this.nowTick = Date.now();
          this.autoRefreshStart();
        }
      };
      document.addEventListener("visibilitychange", this._onVisible);
      this._onFocus = () => {
        this.nowTick = Date.now();
        this.autoRefreshStart();
      };
      window.addEventListener("focus", this._onFocus);
      window.tlOnWindowResume = () => {
        this.nowTick = Date.now();
        this.autoRefreshStart();
      };
      // 跨午夜后“今天/昨天”和顶部日期要自动翻页，不要求用户刷新
      this._nowTimer = setInterval(() => { this.nowTick = Date.now(); }, 60000);
      // 展示数据文件位置，明确档案是持久化的
      api("/api/health", { silent: true })
        .then(h => {
          this.dataPath = h.data_path || "";
          this.appVersion = h.version || "";
          this.appPort = h.port || "";
        })
        .catch(() => {});
      // 偏好：默认是否显示废弃项目（归档始终展示）
      api("/api/settings", { silent: true })
        .then(p => {
          this.prefs = p || {};
          if (p && p["ui.show_discarded_default"]) this.showDiscarded = true;
        })
        .catch(() => {});
      // 全局快捷键：/ 聚焦搜索；Esc 关弹窗或清空搜索
      this._onKey = (e) => {
        const tag = (e.target.tagName || "").toLowerCase();
        const typing = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
        if (e.key === "/" && !typing) {
          e.preventDefault();
          const s = document.querySelector('input[type="search"]');
          if (s) s.focus();
          return;
        }
        if (e.key === "Escape") {
          if (this.showNavConfig) { this.closeNavConfig(); return; }
          if (this.toolsOpen) { this.toolsOpen = false; return; }
          if (this.$refs.settings && this.$refs.settings.visible) {
            this.$refs.settings.close();
            return;
          }
          if (this.showAdd || this.showScan || this.showDay) {
            this.showAdd = false; this.showScan = false; this.showDay = false;
            return;
          }
          if (this.sidebarOpen) { this.sidebarOpen = false; return; }
          if (typing && document.activeElement.type === "search") {
            this.q = "";
            document.activeElement.blur();
          }
        }
      };
      document.addEventListener("keydown", this._onKey);
    },
    beforeUnmount() {
      this._disposed = true;                    // 停止自动更新轮询与回填
      clearTimeout(this._arTimer);
      clearInterval(this._nowTimer);
      document.removeEventListener("visibilitychange", this._onVisible);
      window.removeEventListener("focus", this._onFocus);
      window.tlOnWindowResume = null;
      document.removeEventListener("keydown", this._onKey);
    },
  });

  // 注入公共工具函数（fmtTime/copyText 等），供模板表达式调用
  Object.assign(app.config.globalProperties, window.TL_HELPERS);
  app.component("tl-select", window.TlSelect);
  app.component("tl-icon", window.TlIcon);
  app.component("tl-tabbar", window.TlTabbar);
  app.component("tl-settings-dialog", window.TlSettingsDialog);
  app.directive("modal", window.TlModal);
  const root = app.mount("#app");
  // 根实例挂在 window 上：托盘「打开设置」与自动化验证（首页自动更新）共用
  window.__tlHomeVM = root;
  // 软导航切换页面时要卸载本应用（见 common.js 的 softNavigate），
  // 否则旧实例的事件监听 / 定时器会跟着页面残留下来
  window.__tlPageApp = app;
  // 桌面托盘「打开设置」的入口（desktop.py 通过 evaluate_js 调用；
  // 项目详情页没有此方法，托盘侧会回退为跳回首页）
  window.TL_OPEN_SETTINGS = () => root.openSettings();
})();
