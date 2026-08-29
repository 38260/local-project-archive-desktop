/* 项目详情页：元信息、笔记编辑、README 渲染、目录树、快捷操作 */
(function () {
  "use strict";
  const { createApp } = Vue;

  // 递归目录树组件
  const TreeNode = {
    name: "tree-node",
    props: {
      node: { type: Object, required: true },
      depth: { type: Number, default: 0 },
    },
    data() {
      // 前两层默认展开，更深层默认折叠
      return { open: this.depth < 2 };
    },
    computed: {
      isDir() { return this.node.type === "dir"; },
    },
    template: `
      <li class="t-row" :class="{ 't-file': !isDir }">
        <template v-if="isDir">
          <span class="t-dir" @click="open = !open">
            <span class="t-caret">{{ open ? "▾" : "▸" }}</span>{{ open ? "📂" : "📁" }}
            <span class="t-name">{{ node.name }}</span>
          </span>
          <span class="t-err" v-if="node.error">（{{ node.error }}）</span>
          <ul v-show="open">
            <tree-node v-for="c in node.children" :key="c.name" :node="c" :depth="depth + 1"></tree-node>
          </ul>
        </template>
        <template v-else>
          <span class="t-caret"></span>📄
          <span class="t-name">{{ node.name }}</span>
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
        // 笔记
        descTab: "edit",
        descHtml: "",
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
        expandedCommits: [],
        // 截图
        screenshots: [],
        previewShot: null,
        uploadingShots: false,
        shotsDrag: false,
        // 更多菜单 / 描述实时预览
        moreOpen: false,
        descLive: "",
        _descTimer: null,
        // 目录树收起状态（记忆在 localStorage，默认展开）
        treeCollapsed: localStorage.getItem("lpa-tree-collapsed") === "1",
        // 左侧锚点目录（sections 已改为计算属性，空面板自动隐藏）
        activeSection: "sec-info",
        spySuspendedUntil: 0,
      };
    },
    computed: {
      gitInfo() {
        return (this.meta && this.meta.git) || { is_repo: false };
      },
      themeName() {
        return document.documentElement.getAttribute("data-theme") === "dark" ? "暗色" : "亮色";
      },
      // 头部数据徽章
      headBadges() {
        const m = this.meta || {};
        const b = [];
        if (this.gitInfo.is_repo) {
          b.push({ ico: "⑂", label: "提交", val: this.fmtNum(this.gitInfo.commit_count) });
        }
        if (m.stats) {
          b.push({ ico: "▤", label: "文件", val: this.fmtNum(m.stats.file_count) });
          b.push({ ico: "▣", label: "体积", val: this.fmtSize(m.stats.total_size) });
        }
        const langs = (this.p && this.p.tags || []).filter(t => this.tagClass(t) === "tag tag-lang")
          .slice(0, 2).join(" / ");
        if (langs) b.push({ ico: "◈", label: "语言", val: langs });
        return b;
      },
      // 近 12 周提交热力格（基于已加载提交）
      heatmap() {
        if (!this.commitData || !this.commitData.commits.length) return [];
        const days = {};
        for (const c of this.commitData.commits) {
          days[c.date.slice(0, 10)] = (days[c.date.slice(0, 10)] || 0) + 1;
        }
        const cells = [];
        const now = new Date();
        const start = new Date(now);
        start.setDate(start.getDate() - 83 - ((now.getDay() + 6) % 7));
        for (let i = 0; i < 84; i++) {
          const d = new Date(start);
          d.setDate(start.getDate() + i);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          const n = days[key] || 0;
          cells.push({ key: key + i, count: n,
                       level: n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 3 : 4,
                       label: `${key}：${n} 次提交` });
        }
        return cells;
      },
      // 左侧目录：隐藏空内容面板的锚点
      sections() {
        const list = [
          { id: "sec-info", label: "基础信息" },
          { id: "sec-git", label: "Git 信息", hide: !this.gitInfo.is_repo },
          { id: "sec-configs", label: "构建配置", hide: !(this.meta && this.meta.configs && this.meta.configs.length) },
          { id: "sec-stats", label: "文件统计", hide: false },
          { id: "sec-desc", label: "项目描述", hide: false },
          { id: "sec-notes", label: "开发笔记", hide: this.notes.length === 0 && this.noteDraft === null },
          { id: "sec-changelogs", label: "变更日志", hide: this.changelogs.length === 0 && this.logDraft === null },
          { id: "sec-commits", label: "提交记录", hide: !(this.commitData && this.commitData.is_repo && this.commitData.commits.length) },
          { id: "sec-shots", label: "截图", hide: this.screenshots.length === 0 },
          { id: "sec-readme", label: "README", hide: !(this.readme && this.readme.exists) },
        ];
        return list.filter(x => !x.hide);
      },
      // 依赖版本统计：固定(==) / 范围(^ ~ > <) / 未标注
      depStats() {
        const all = [];
        for (const c of (this.meta && this.meta.configs) || []) {
          for (const d of c.dependencies || []) all.push(d);
        }
        const pinnedList = all.filter(d => d.includes("=="));
        const isRange = d => /[~^><=]/.test(d) && !d.includes("==");
        const rangedList = all.filter(d => !d.includes("==") && isRange(d));
        const unpinnedList = all.filter(d => !d.includes("==") && !isRange(d));
        return {
          total: all.length,
          pinned: pinnedList.length,
          ranged: rangedList.length,
          unpinned: unpinnedList.length,
          unpinnedList: unpinnedList.slice(0, 8),
        };
      },
      // 按月统计提交数（基于当前加载的记录），简易柱状图数据
      commitMonths() {
        if (!this.commitData || !this.commitData.commits.length) return [];
        const byMonth = {};
        for (const c of this.commitData.commits) {
          const key = c.date.slice(0, 7); // YYYY-MM
          byMonth[key] = (byMonth[key] || 0) + 1;
        }
        const keys = Object.keys(byMonth).sort().slice(-6);
        const max = Math.max(...keys.map(k => byMonth[k]), 1);
        return keys.map(k => ({
          key: k,
          label: Number(k.slice(5, 7)) + "月",
          count: byMonth[k],
          pct: Math.round((byMonth[k] / max) * 100),
        }));
      },
    },
    methods: {
      async load() {
        try {
          const p = await api(`/api/projects/${this.projectId}`);
          this.p = p;
          this.statuses = p.statuses || [];
          this.meta = p.auto_meta || {};
          this.descHtml = p.description_html || "";
          this.descLive = p.description_html || "";
          this.newPath = p.is_lost ? "" : p.path;
          this.loadReadme();
          this.loadTree();
          this.loadNotes();
          this.loadChangelogs();
          this.loadCommits();
          this.loadShots();
        } catch (e) {
          if (e.status === 404) this.notFound = true;
        }
      },
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
        if (!confirm("确定删除这条笔记吗？删除后不可恢复。")) return;
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
        this.logDraftDate = new Date().toISOString().slice(0, 10);
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
        if (!confirm(`确定删除变更日志「${c.title || "未命名条目"}」吗？`)) return;
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
        this.uploadingShots = true;
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
          e.target.value = "";
        }
      },
      async deleteShot(s) {
        if (!confirm("确定删除这张截图吗？")) return;
        try {
          await api(`/api/projects/${this.projectId}/screenshots/${encodeURIComponent(s.file)}`,
                    { method: "DELETE" });
          toast("截图已删除", "ok");
          this.loadShots();
        } catch (e) { /* toast 已提示 */ }
      },
      // ---- 导出 HTML 档案 ----
      exportHtml() {
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
        clearTimeout(this._descTimer);
        this._descTimer = setTimeout(async () => {
          try {
            const r = await api("/api/render-md", {
              method: "POST", body: { text: this.p.description || "", mode: "notes" }, silent: true,
            });
            this.descLive = r.html;
          } catch (e) { /* 静默 */ }
        }, 500);
      },
      // ---- Git 提交记录 ----
      async loadCommits() {
        this.commitLoading = true;
        this.expandedCommits = [];
        try {
          this.commitData = await api(`/api/projects/${this.projectId}/commits`, { silent: true });
        } catch (e) {
          this.commitData = null;
        } finally {
          this.commitLoading = false;
        }
      },
      firstLine(msg) { return ((msg || "").split("\n")[0] || "").slice(0, 120); },
      toggleTree() {
        this.treeCollapsed = !this.treeCollapsed;
        localStorage.setItem("lpa-tree-collapsed", this.treeCollapsed ? "1" : "0");
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
      async previewDesc() {
        this.descTab = "preview";
        try {
          const r = await api("/api/render-md", {
            method: "POST", body: { text: this.p.description || "（暂无内容）", mode: "notes" },
          });
          this.descHtml = r.html;
        } catch (e) { /* toast 已提示 */ }
      },
      async saveDesc() {
        this.savingDesc = true;
        try {
          await api(`/api/projects/${this.projectId}`, {
            method: "PUT", body: { description: this.p.description },
          });
          toast("笔记已保存到本机数据库", "ok");
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
      async rescan() {
        this.rescanning = true;
        try {
          const r = await api(`/api/projects/${this.projectId}/rescan`, { method: "POST" });
          this.p = r;
          this.meta = r.auto_meta || {};
          this.descHtml = r.description_html || "";
          if (r.parse_ok) {
            toast("重新解析完成", "ok");
            this.readme = null;
            this.tree = undefined;
            this.loadReadme();
            this.loadTree();
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
          this.p = p;
          this.meta = p.auto_meta || {};
          this.descHtml = p.description_html || "";
          this.newPath = p.path;
          toast("路径已更新并重新解析", "ok");
          this.readme = null;
          this.tree = undefined;
          this.loadReadme();
          this.loadTree();
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
          this.p = p;
          this.meta = p.auto_meta || {};
          this.descHtml = p.description_html || "";
          this.showEdit = false;
          this.newPath = p.path;
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
      // 拖拽文件到截图面板上传
      async dropShots(e) {
        this.shotsDrag = false;
        const files = [...(e.dataTransfer?.files || [])];
        if (!files.length) return;
        const fd = new FormData();
        files.forEach(f => fd.append("files", f));
        try {
          const resp = await fetch(`/api/projects/${this.projectId}/screenshots`, {
            method: "POST", body: fd,
          });
          const r = await resp.json();
          if (!resp.ok) throw new Error(r.detail || "上传失败");
          let msg = `已保存 ${r.saved.length} 张截图`;
          if (r.errors.length) msg += `，${r.errors.length} 张失败`;
          toast(msg, r.errors.length ? "error" : "ok");
          this.loadShots();
        } catch (err) {
          toast("拖拽上传失败：" + err.message, "error");
        }
      },
      // 目录树：点击文件复制相对路径
      copyRel(node) { this.copyText(node.rel || node.name); },
      async removeProject() {
        if (!confirm(`确定删除「${this.p.name}」的档案记录吗？\n\n仅删除本系统中的索引数据，不会改动原项目文件夹的任何文件。`)) return;
        try {
          await api(`/api/projects/${this.projectId}`, { method: "DELETE" });
          toast("档案记录已删除", "ok");
          setTimeout(() => { location.href = "/"; }, 600);
        } catch (e) { /* toast 已提示 */ }
      },
    },
    mounted() {
      this.load();
      window.addEventListener("scroll", this.onScroll, { passive: true });
      // Esc 关闭更多菜单 / 编辑弹窗
      this._onKey = (e) => {
        if (e.key === "Escape") {
          if (this.moreOpen) { this.moreOpen = false; return; }
          if (this.showEdit) this.showEdit = false;
        }
      };
      document.addEventListener("keydown", this._onKey);
    },
    beforeUnmount() {
      window.removeEventListener("scroll", this.onScroll);
      document.removeEventListener("keydown", this._onKey);
    },
  });

  app.component("tree-node", TreeNode);
  app.component("lpa-select", window.LpaSelect);
  // 注入公共工具函数（fmtTime/copyText 等），供模板表达式调用
  Object.assign(app.config.globalProperties, window.LPA_HELPERS);
  app.mount("#app");
})();
