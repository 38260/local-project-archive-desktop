/* 首页仪表盘：项目卡片、搜索筛选、手动录入、批量扫描 */
(function () {
  "use strict";
  const { createApp } = Vue;

  const app = createApp({
      data() {
      return {
        loading: true,
        dataPath: "",
        rescanningAll: false,
        rescanProgress: null,
        projects: [],
        stats: { total: 0, active: 0, archived: 0, lost: 0 },
        statuses: [],
        // 筛选
        q: "",
        statusFilter: "",
        tagFilter: "",
        showArchived: false,
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
      };
    },
    computed: {
      themeName() { return document.documentElement.getAttribute("data-theme") === "dark" ? "暗色" : "亮色"; },
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
      filtered() {
        const q = this.q.toLowerCase();
        return this.projects.filter(p => {
          if (this.statusFilter && p.status !== this.statusFilter) return false;
          if (this.tagFilter && !(p.tags || []).includes(this.tagFilter)) return false;
          if (!this.showArchived && p.status === "归档废弃") return false;
          if (q) {
            const hay = [p.name, p.alias, p.path, p.category, (p.tags || []).join(",")]
              .join(" ").toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });
      },
      checkedCount() {
        return this.candidates ? this.candidates.candidates.filter(c => c.checked).length : 0;
      },
      // 有搜索或筛选时合成单个"搜索结果"组（平铺），默认视图按状态分组
      displayGroups() {
        if (this.q || this.statusFilter || this.tagFilter) {
          return [{ status: "搜索结果", items: this.filtered }];
        }
        const order = ["进行中", "已完成", "暂停", "归档废弃"];
        const map = {};
        for (const p of this.filtered) {
          (map[p.status] = map[p.status] || []).push(p);
        }
        return order.filter(s => map[s]).map(s => ({ status: s, items: map[s] }));
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
      async quickOpen(p, target) {
        try {
          await api(`/api/projects/${p.id}/open`, { method: "POST", body: { target } });
          toast(target === "vscode" ? "已在 VS Code 打开" : "已在资源管理器打开", "ok");
        } catch (e) { /* toast 已提示 */ }
      },
      exportJson() { location.href = "/api/export"; },
      async rescanAll() {
        if (!this.projects.length) { toast("暂无项目可解析", "error"); return; }
        if (!confirm(`用最新解析器重新解析全部 ${this.projects.length} 个项目？\n\n已有标签会保留，新识别的技术栈会补充进来。`)) return;
        this.rescanningAll = true;
        let ok = 0, lost = 0;
        try {
          for (const p of this.projects) {
            this.rescanProgress = { done: ok + lost, total: this.projects.length, name: p.name };
            try {
              const r = await api(`/api/projects/${p.id}/rescan`, { method: "POST", silent: true });
              r.parse_ok === false ? lost++ : ok++;
            } catch (e) { lost++; }
          }
          let msg = `已重新解析 ${ok} 个项目`;
          if (lost) msg += `，${lost} 个路径丢失或失败`;
          toast(msg, lost ? "error" : "ok");
          this.load();
        } finally {
          this.rescanningAll = false;
          this.rescanProgress = null;
        }
      },

      // ---- 手动录入 ----
      openAdd() {
        this.form = this.emptyForm();
        this.showAdd = true;
        this.$nextTick(() => this.$refs.pathInput && this.$refs.pathInput.focus());
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
      openScan() { this.showScan = true; this.candidates = null; this.scanRoot = ""; },
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
          if (this.showAdd || this.showScan) { this.showAdd = false; this.showScan = false; return; }
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
  app.mount("#app");
})();
