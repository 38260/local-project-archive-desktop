/* 首页仪表盘：项目卡片、搜索筛选、手动录入、批量扫描 */
(function () {
  "use strict";
  const { createApp } = Vue;

  // 排序下拉的中文标签 → 内部排序键
  const SORT_LABELS = ["最近更新", "最近修改", "名称", "创建时间", "状态"];
  const SORT_KEYS = {
    "最近更新": "updated", "最近修改": "modified", "名称": "name",
    "创建时间": "created", "状态": "status",
  };
  const STATUS_ORDER = ["进行中", "已完成", "暂停", "归档废弃"];

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
        stats: { total: 0, active: 0, archived: 0, lost: 0 },
        statuses: [],
        themeTick: 0,
        // 筛选
        q: "",
        statusFilter: "",
        tagFilter: "",
        catFilter: "",
        showArchived: false,
        quickFilter: null,   // null | "active" | "lost"（统计卡下钻用）
        sortBy: "最近更新",
        sortOptions: SORT_LABELS,
        // 首页总热力图（全部项目提交聚合）
        heat: null,
        heatWeeks: 53,
        heatCollapsed: localStorage.getItem("lpa-home-heat-collapsed") === "1",
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
        importForm: { category: "" },
        // 通用设置键值（来自 /api/settings；设置弹窗本体在共享组件 js/settings.js）
        prefs: {},
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
        // 置顶项目优先，其余按所选排序
        return this.projects.slice().sort(
          (a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || cmp(a, b));
      },
      filtered() {
        const q = this.q.toLowerCase();
        return this.sorted.filter(p => {
          if (this.statusFilter && p.status !== this.statusFilter) return false;
          if (this.tagFilter && !(p.tags || []).includes(this.tagFilter)) return false;
          if (this.catFilter && p.category !== this.catFilter) return false;
          if (!this.showArchived && p.status === "归档废弃") return false;
          // 统计卡下钻：活跃 = 非归档且路径有效；丢失 = 路径失效
          if (this.quickFilter === "active" && (p.status === "归档废弃" || p.is_lost)) return false;
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
        if (this.showArchived) f.push({ k: "arch", label: "含归档项目", clear: () => { this.showArchived = false; } });
        return f;
      },
      checkedCount() {
        return this.candidates ? this.candidates.candidates.filter(c => c.checked).length : 0;
      },
      // 有搜索或筛选时合成单个"搜索结果"组（平铺），默认视图按状态分组
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
      goto(p) { location.href = "/project/" + p.id; },
      switchTheme() { window.cycleTheme(); this.themeTick++; },
      chooseTheme(v) { window.setThemePref(v); this.themeTick++; },
      statActive(kind) {
        if (kind === "total") return !this.quickFilter && !this.statusFilter && this.showArchived;
        if (kind === "active") return this.quickFilter === "active";
        if (kind === "archived") return this.statusFilter === "归档废弃";
        if (kind === "lost") return this.quickFilter === "lost";
        return false;
      },
      // 统计卡下钻：把数字变成筛选条件
      applyStatFilter(kind) {
        const already = this.statActive(kind);
        this.clearFilters();
        if (already) return; // 再次点击 = 取消下钻，回到默认视图
        if (kind === "total") this.showArchived = true;
        else if (kind === "active") this.quickFilter = "active";
        else if (kind === "archived") { this.statusFilter = "归档废弃"; this.showArchived = true; }
        else if (kind === "lost") { this.quickFilter = "lost"; this.showArchived = true; }
        window.scrollTo({ top: 0, behavior: "smooth" });
      },
      clearFilters() {
        this.q = "";
        this.statusFilter = "";
        this.tagFilter = "";
        this.catFilter = "";
        this.quickFilter = null;
        this.showArchived = false;
      },
      async quickOpen(p, target) {
        try {
          await api(`/api/projects/${p.id}/open`, { method: "POST", body: { target } });
          toast(target === "vscode" ? "已在 VS Code 打开" : "已在资源管理器打开", "ok");
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
        location.href = "/api/export";
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
        try {
          const p = await api("/api/projects/rescan-all/progress", { silent: true });
          this.rescanProgress = p;
          if (p.running) {
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
        finally { this.rescanningAll = false; }
      },

      async loadPrefs() {
        try {
          this.prefs = await api("/api/settings", { silent: true });
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
        try {
          this.heat = await api(`/api/heatmap?weeks=${this.heatWeeks}`, { silent: true });
        } catch (e) { this.heat = null; }
      },
      toggleHeat() {
        this.heatCollapsed = !this.heatCollapsed;
        localStorage.setItem("lpa-home-heat-collapsed", this.heatCollapsed ? "1" : "0");
      },
      // ---- 设置（共享弹窗，见 js/settings.js） ----
      openSettings() { this.$refs.settings.open(); },
      // 设置变更联动：prefs=刷新编辑器按钮/主题/热力图范围等联动状态；
      // data=数据被导入/恢复/清空，整页重新加载
      onSettingsChanged(kind, key, value) {
        this.themeTick++;
        if (key === "ui.show_archived_default") this.showArchived = !!value;
        this.loadPrefs();
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
        this.submitting = true;
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
            },
          });
          toast(`「${p.name}」录入成功，已解析 ${p.auto_meta.configs.length} 个配置文件`, "ok");
          this.showAdd = false;
          this.load();
        } catch (e) { /* toast 已提示 */ }
        finally { this.submitting = false; }
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
        try {
          const data = await api("/api/scan", {
            method: "POST",
            body: { root: this.scanRoot, max_depth: this.scanDepth },
          });
          data.candidates.forEach(c => { c.checked = !c.imported; });
          this.candidates = data;
          if (!data.candidates.length) toast("未发现候选项目", "ok");
          // 记住本次扫描目录，下次打开直接用
          api("/api/settings", {
            method: "PUT", body: { "scan.last_root": this.scanRoot }, silent: true,
          }).catch(() => {});
        } catch (e) { /* toast 已提示 */ }
        finally { this.scanning = false; }
      },
      async doImport() {
        const paths = this.candidates.candidates.filter(c => c.checked).map(c => c.path);
        if (!paths.length) return;
        this.importing = true;
        try {
          const r = await api("/api/scan/import", {
            method: "POST",
            body: { paths, category: this.importForm.category, status: "进行中", tags: [] },
          });
          let msg = `导入 ${r.imported} 个项目，跳过 ${r.skipped} 个已存在`;
          if (r.failed.length) msg += `，失败 ${r.failed.length} 个：${r.failed[0].path}（${r.failed[0].reason}）`;
          toast(msg, r.failed.length ? "error" : "ok");
          this.closeScan();
          this.load();
        } catch (e) { /* toast 已提示 */ }
        finally { this.importing = false; }
      },
    },
    mounted() {
      this.load();
      // 展示数据文件位置，明确档案是持久化的
      api("/api/health", { silent: true })
        .then(h => {
          this.dataPath = h.data_path || "";
          this.appVersion = h.version || "";
          this.appPort = h.port || "";
        })
        .catch(() => {});
      // 偏好：默认是否显示归档项目
      api("/api/settings", { silent: true })
        .then(p => {
          this.prefs = p || {};
          if (p && p["ui.show_archived_default"]) this.showArchived = true;
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
          if (this.$refs.settings && this.$refs.settings.visible) {
            this.$refs.settings.close();
            return;
          }
          if (this.showAdd || this.showScan) {
            this.showAdd = false; this.showScan = false;
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
    beforeUnmount() { document.removeEventListener("keydown", this._onKey); },
  });

  // 注入公共工具函数（fmtTime/copyText 等），供模板表达式调用
  Object.assign(app.config.globalProperties, window.LPA_HELPERS);
  app.component("lpa-select", window.LpaSelect);
  app.component("lpa-icon", window.LpaIcon);
  app.component("lpa-settings-dialog", window.LpaSettingsDialog);
  app.directive("modal", window.LpaModal);
  app.mount("#app");
})();
