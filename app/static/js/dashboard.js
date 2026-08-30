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
        rescanningAll: false,
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
        // 设置
        showSettings: false,
        autostart: { enabled: false, available: false, saving: false },
        importingBackup: false,
        backups: [],
        backupEnabled: true,
        backupKeep: 10,
        backupSaving: false,
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
        return this.projects.slice().sort(cmp);
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
      },
      goto(p) { location.href = "/project/" + p.id; },
      switchTheme() { window.cycleTheme(); this.themeTick++; },
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
      exportJson() { location.href = "/api/export"; },
      // 用后端批量接口一次性解析（内部线程池并发），避免串行 N 次请求
      async rescanAll() {
        if (!this.projects.length) { toast("暂无项目可解析", "error"); return; }
        if (!confirm(`用最新解析器重新解析全部 ${this.projects.length} 个项目？\n\n已有标签会保留，新识别的技术栈会补充进来。`)) return;
        this.rescanningAll = true;
        try {
          const r = await api("/api/projects/rescan-all", { method: "POST" });
          let msg = `已重新解析 ${r.rescanned} 个项目`;
          if (r.failed.length) {
            msg += `，${r.failed.length} 个失败：${r.failed[0].name}（${r.failed[0].reason}）`;
          }
          toast(msg, r.failed.length ? "error" : "ok");
          this.load();
        } catch (e) { /* toast 已提示 */ }
        finally { this.rescanningAll = false; }
      },

      // ---- 设置 ----
      openSettings() {
        this.showSettings = true;
        this.loadAutostart();
        this.loadBackups();
      },
      async loadAutostart() {
        try {
          const r = await api("/api/settings/autostart", { silent: true });
          this.autostart.enabled = !!r.enabled;
          this.autostart.available = !!r.available;
        } catch (e) {
          this.autostart.available = false;
        }
      },
      async toggleAutostart() {
        this.autostart.saving = true;
        const wanted = this.autostart.enabled;
        try {
          const r = await api("/api/settings/autostart", {
            method: "PUT", body: { enabled: wanted },
          });
          this.autostart.enabled = !!r.enabled;
          toast(r.enabled ? "已开启开机自启动" : "已关闭开机自启动", "ok");
        } catch (e) {
          this.autostart.enabled = !wanted;   // 失败回滚
        } finally {
          this.autostart.saving = false;
        }
      },
      async importBackup(e) {
        const file = e.target.files && e.target.files[0];
        e.target.value = "";
        if (!file) return;
        let payload;
        try {
          payload = JSON.parse(await file.text());
        } catch (err) {
          toast("备份文件读取失败：不是有效的 JSON", "error");
          return;
        }
        if (!Array.isArray(payload.projects)) {
          toast("不是本系统导出的备份文件（缺少 projects 列表）", "error");
          return;
        }
        if (!confirm(`将导入 ${payload.projects.length} 个项目档案（已存在的路径会自动跳过）。继续吗？`)) return;
        this.importingBackup = true;
        try {
          const r = await api("/api/import", { method: "POST", body: payload });
          let msg = `导入 ${r.imported} 个项目，跳过 ${r.skipped} 个已存在`;
          if (r.failed.length) msg += `，${r.failed.length} 个失败`;
          toast(msg, r.failed.length ? "error" : "ok");
          this.load();
        } catch (err) { /* toast 已提示 */ }
        finally { this.importingBackup = false; }
      },
      async loadBackups() {
        try {
          const r = await api("/api/settings/backups", { silent: true });
          this.backups = r.backups || [];
          this.backupEnabled = !!r.auto_enabled;
          this.backupKeep = r.keep || 10;
        } catch (e) { /* 静默 */ }
      },
      async saveBackupPrefs() {
        this.backupSaving = true;
        const keep = Math.min(99, Math.max(1, Number(this.backupKeep) || 10));
        try {
          await api("/api/settings", {
            method: "PUT",
            body: { "backup.enabled": !!this.backupEnabled, "backup.keep": keep },
          });
          this.backupKeep = keep;
        } catch (e) {
          this.loadBackups();   // 失败回滚显示
        } finally { this.backupSaving = false; }
      },
      async backupNow() {
        this.backupSaving = true;
        try {
          const r = await api("/api/settings/backups", { method: "POST" });
          toast(`已创建备份：${r.name}`, "ok");
          this.loadBackups();
        } catch (e) { /* toast 已提示 */ }
        finally { this.backupSaving = false; }
      },
      async restoreBackup(b) {
        if (!confirm(`用备份 ${b.name}（${fmtTime(b.mtime)}）覆盖当前档案数据？\n\n恢复前会先自动备份当前数据，误操作可再次恢复。`)) return;
        this.backupSaving = true;
        try {
          await api("/api/settings/backups/restore", { method: "POST", body: { name: b.name } });
          toast("已从备份恢复，正在刷新列表…", "ok");
          this.load();
          this.loadBackups();
        } catch (e) { /* toast 已提示 */ }
        finally { this.backupSaving = false; }
      },
      async deleteBackup(b) {
        if (!confirm(`删除备份 ${b.name}？删除后不可恢复。`)) return;
        try {
          await api("/api/settings/backups", { method: "DELETE", body: { name: b.name } });
          toast("备份已删除", "ok");
          this.loadBackups();
        } catch (e) { /* toast 已提示 */ }
      },

      // ---- 手动录入 ----
      openAdd() {
        this.form = this.emptyForm();
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
      openScan() {
        this.showScan = true;
        this.candidates = null;
        this.scanRoot = "";
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
        .then(h => { this.dataPath = h.data_path || ""; })
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
          if (this.showAdd || this.showScan || this.showSettings) {
            this.showAdd = false; this.showScan = false; this.showSettings = false;
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
  app.directive("modal", window.LpaModal);
  app.mount("#app");
})();
