/* 首页仪表盘：项目卡片、搜索筛选、手动录入、批量扫描 */
(function () {
  "use strict";
  const { createApp } = Vue;

  // 排序下拉：规则只做「一键整理」，拖动卡片随时覆盖排列（没有独立的手动排序模式）
  const SORT_LABELS = ["最近更新", "最近修改", "名称", "创建时间", "状态"];
  const SORT_KEYS = {
    "最近更新": "updated", "最近修改": "modified", "名称": "name",
    "创建时间": "created", "状态": "status",
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
        // 筛选
        q: "",
        statusFilter: "",
        tagFilter: "",
        catFilter: "",
        showDiscarded: false,   // 废弃项目默认隐藏，勾选后显示（归档始终展示）
        quickFilter: null,   // null | "active" | "lost"（统计卡下钻用）
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
      sorted() {
        const key = SORT_KEYS[this.sortBy] || "updated";
        const byTime = (f) => (a, b) => String(b[f] || "").localeCompare(String(a[f] || ""));
        const cmp = {
          updated: byTime("updated_at"),
          modified: byTime("fs_modified"),
          created: byTime("created_at"),
          name: (a, b) => a.name.localeCompare(b.name, "zh-CN"),
          status: (a, b) => (STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
                            || byTime("updated_at")(a, b),
        }[key];
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
        const q = this.q.toLowerCase();
        return this.sorted.filter(p => {
          if (this.statusFilter && p.status !== this.statusFilter) return false;
          if (this.tagFilter && !(p.tags || []).includes(this.tagFilter)) return false;
          if (this.catFilter && p.category !== this.catFilter) return false;
          // 归档=有意收尾留档，始终展示；废弃=彻底不要，默认隐藏
          if (!this.showDiscarded && p.status === "废弃") return false;
          // 统计卡下钻：活跃 = 未归档/未废弃且路径有效；丢失 = 路径失效
          if (this.quickFilter === "active"
              && (p.status === "归档" || p.status === "废弃" || p.is_lost)) return false;
          if (this.quickFilter === "lost" && !p.is_lost) return false;
          if (q) {
            const hay = [p.name, p.alias, p.path, p.category, (p.tags || []).join(",")]
              .join(" ").toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });
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
        if (this.showDiscarded) f.push({ k: "arch", label: "含废弃项目", clear: () => { this.showDiscarded = false; } });
        return f;
      },
      checkedCount() {
        return this.candidates ? this.candidates.candidates.filter(c => c.checked).length : 0;
      },
      // 永远保留状态分组；有搜索或筛选时合成单个"搜索结果"组（平铺）。
      // 拖动顺序只作用于组内先后，不再切换到「置顶项目 / 项目」的另一种视图。
      displayGroups() {
        if (this.q || this.statusFilter || this.tagFilter || this.catFilter || this.quickFilter) {
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
        if (this.orderSaving) { ev.preventDefault(); return; }
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
        // 同状态 + 同置顶边界内的相邻项（组内移动）
        const items = this.filtered.filter(item =>
          item.status === p.status && !!item.pinned === !!p.pinned);
        const target = items[items.findIndex(item => item.id === p.id) + direction];
        if (target) return this.moveProject(p.id, target.id, direction > 0);
      },
      async moveProject(id, targetId, after) {
        if (this.orderSaving || id === targetId) return;
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
        if (document.visibilityState === "visible") this.autoRefreshStart();
      };
      document.addEventListener("visibilitychange", this._onVisible);
      this._onFocus = () => this.autoRefreshStart();
      window.addEventListener("focus", this._onFocus);
      window.tlOnWindowResume = () => this.autoRefreshStart();
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
          if (this.toolsOpen) { this.toolsOpen = false; return; }
          if (this.$refs.settings && this.$refs.settings.visible) {
            this.$refs.settings.close();
            return;
          }
          if (this.showAdd || this.showScan || this.showDay) {
            this.showAdd = false; this.showScan = false; this.showDay = false;
            return;
          }
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
