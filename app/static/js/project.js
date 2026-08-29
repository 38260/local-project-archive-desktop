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
        // 目录树收起状态（记忆在 localStorage，默认展开）
        treeCollapsed: localStorage.getItem("lpa-tree-collapsed") === "1",
        // 左侧锚点目录
        sections: [
          { id: "sec-info", label: "基础信息" },
          { id: "sec-git", label: "Git 信息" },
          { id: "sec-configs", label: "构建配置" },
          { id: "sec-stats", label: "文件统计" },
          { id: "sec-desc", label: "项目描述" },
          { id: "sec-notes", label: "开发笔记" },
          { id: "sec-changelogs", label: "变更日志" },
          { id: "sec-commits", label: "提交记录" },
          { id: "sec-readme", label: "README" },
        ],
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
          this.newPath = p.is_lost ? "" : p.path;
          this.loadReadme();
          this.loadTree();
          this.loadNotes();
          this.loadChangelogs();
          this.loadCommits();
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
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      },
      // 滚动监听：高亮当前视口所在的面板
      onScroll() {
        if (Date.now() < (this.spySuspendedUntil || 0)) return;
        const offset = 90; // 与 sticky 顶栏高度对应
        let current = "";
        for (const s of this.sections) {
          const el = document.getElementById(s.id);
          if (el && el.getBoundingClientRect().top <= offset) current = s.id;
        }
        this.activeSection = current || this.sections[0].id;
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
    },
    beforeUnmount() {
      window.removeEventListener("scroll", this.onScroll);
    },
  });

  app.component("tree-node", TreeNode);
  // 注入公共工具函数（fmtTime/copyText 等），供模板表达式调用
  Object.assign(app.config.globalProperties, window.LPA_HELPERS);
  app.mount("#app");
})();
