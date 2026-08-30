/* 公共工具：主题切换、API 封装、Toast、格式化、图标、模态框可达性 */
(function () {
  "use strict";

  // ---------- 主题（三态：跟随系统 / 亮色 / 暗色） ----------
  const THEME_KEY = "lpa-theme";
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  function resolveTheme(pref) {
    return (pref === "light" || pref === "dark") ? pref : (mq.matches ? "dark" : "light");
  }
  function applyTheme(pref) {
    document.documentElement.setAttribute("data-theme", resolveTheme(pref));
    localStorage.setItem(THEME_KEY, pref || "auto");
  }
  function themePref() { return localStorage.getItem(THEME_KEY) || "auto"; }
  applyTheme(themePref());
  // 仅在「跟随系统」模式下响应系统主题变化
  mq.addEventListener("change", () => { if (themePref() === "auto") applyTheme("auto"); });

  window.themePref = themePref;
  window.themeName = function () {
    const p = themePref();
    return p === "auto" ? "跟随系统" : (p === "dark" ? "暗色" : "亮色");
  };
  // 三态轮转：跟随系统 → 亮色 → 暗色
  window.cycleTheme = function () {
    const order = ["auto", "light", "dark"];
    const next = order[(order.indexOf(themePref()) + 1) % 3];
    applyTheme(next);
    return next;
  };
  // 直接指定某一态（设置面板用）
  window.setThemePref = function (pref) {
    if (!["auto", "light", "dark"].includes(pref)) return themePref();
    applyTheme(pref);
    return pref;
  };

  // ---------- Toast（入场/退场动画 + 堆叠上限 + 同文案合并） ----------
  const TOAST_MAX = 4;
  let toastBox = null;
  function ensureToastBox() {
    if (!toastBox) {
      toastBox = document.createElement("div");
      toastBox.className = "toasts";
      document.body.appendChild(toastBox);
    }
    return toastBox;
  }
  function scheduleRemove(el, type) {
    clearTimeout(Number(el.dataset.timer || 0));
    el.dataset.timer = setTimeout(() => {
      if (el.dataset.leaving) return;
      el.dataset.leaving = "1";
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 180);
    }, type === "error" ? 5000 : 2600);
  }
  window.toast = function (msg, type) {
    const box = ensureToastBox();
    // 1.5s 内的同文案合并计数，避免批量操作刷屏
    const now = Date.now();
    const last = box.lastElementChild;
    if (last && last.dataset.msg === msg && now - Number(last.dataset.at || 0) < 1500) {
      const n = Number(last.dataset.n || 1) + 1;
      last.dataset.n = n;
      last.dataset.at = now;
      last.textContent = msg + " ×" + n;
      delete last.dataset.leaving;
      last.classList.remove("leaving");
      scheduleRemove(last, type);
      return;
    }
    const el = document.createElement("div");
    el.className = "toast " + (type || "");
    el.textContent = msg;
    el.dataset.msg = msg;
    el.dataset.at = now;
    el.dataset.n = 1;
    box.appendChild(el);
    while (box.children.length > TOAST_MAX) box.firstElementChild.remove();
    scheduleRemove(el, type);
  };

  // ---------- 统一确认弹窗（替代原生 confirm，风格与应用一致） ----------
  // 用法：const ok = await confirmDialog("确定删除？", { danger: true, okText: "删除" });
  window.confirmDialog = function (message, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      const esc = s => String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      // requireText：需在弹窗内输入指定文本才能确认（危险操作防误触，替代原生 prompt）
      const needText = opts.requireText != null;
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `
        <div class="modal confirm-modal" role="dialog" aria-modal="true">
          <h3>${esc(opts.title || "请确认")}</h3>
          <div class="confirm-msg"></div>
          <div class="confirm-input-row" style="display:none">
            <input type="text" class="c-input" autocomplete="off" spellcheck="false"
                   aria-label="确认文本">
          </div>
          <div class="actions">
            <button type="button" class="btn c-cancel">${esc(opts.cancelText || "取消")}</button>
            <button type="button" class="btn ${opts.danger ? "danger-solid" : "primary"} c-ok">${esc(opts.okText || "确定")}</button>
          </div>
        </div>`;
      mask.querySelector(".confirm-msg").textContent = message;  // textContent 防注入
      const okBtn = mask.querySelector(".c-ok");
      const inputRow = mask.querySelector(".confirm-input-row");
      const input = mask.querySelector(".c-input");
      if (needText) {
        inputRow.style.display = "";
        input.placeholder = opts.requireText;
        okBtn.disabled = true;                      // 输入匹配前禁用确认按钮
        input.addEventListener("input", () => {
          okBtn.disabled = input.value !== opts.requireText;
        });
      }
      let settled = false;
      const done = v => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKey, true);
        mask.remove();
        resolve(v);
      };
      const onKey = e => {
        if (e.key === "Escape") { e.stopPropagation(); done(false); return; }
        // 输入模式下回车 = 尝试确认（值不匹配时按钮禁用，回车无效果）
        if (e.key === "Enter" && needText && input.value === opts.requireText) { e.stopPropagation(); done(input.value); }
      };
      document.addEventListener("keydown", onKey, true);
      mask.querySelector(".c-cancel").onclick = () => done(false);
      okBtn.onclick = () => done(needText ? input.value : true);
      mask.addEventListener("mousedown", e => { if (e.target === mask) done(false); });
      document.body.appendChild(mask);
      (needText ? input : okBtn).focus();
    });
  };

  // ---------- 打开项目的编辑器：命令 → 名称/图标 映射（按钮与设置联动用） ----------
  window.EDITOR_META = {
    "code": { name: "VS Code", icon: "vscode" },
    "code-insiders": { name: "VS Code Insiders", icon: "vscode" },
    "cursor": { name: "Cursor", icon: "cursor" },
    "windsurf": { name: "Windsurf", icon: "code" },
    "subl": { name: "Sublime Text", icon: "code" },
  };
  window.editorIcon = function (cmd) {
    return (window.EDITOR_META[cmd] || {}).icon || "code";
  };
  window.editorName = function (cmd) {
    return (window.EDITOR_META[cmd] || {}).name || cmd || "编辑器";
  };

  // ---------- API ----------
  window.api = async function (path, options) {
    const opt = Object.assign({ headers: {} }, options || {});
    if (opt.body !== undefined && typeof opt.body !== "string") {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(opt.body);
    }
    let resp;
    try {
      resp = await fetch(path, opt);
    } catch (e) {
      toast("无法连接本地服务，请确认 run.py 正在运行", "error");
      throw e;
    }
    let data = null;
    try { data = await resp.json(); } catch (e) { /* 空响应 */ }
    if (!resp.ok) {
      // 422 校验错误的 detail 是对象数组，直接显示会变成 [object Object]
      const d = data && data.detail;
      let msg;
      if (typeof d === "string") msg = d;
      else if (Array.isArray(d) && d.length) msg = d[0].msg || d[0].loc && `字段 ${d[0].loc.join(".")} 无效`;
      msg = msg || `请求失败（HTTP ${resp.status}）`;
      if (!opt.silent) toast(msg, "error");
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    return data;
  };

  // ---------- 格式化 ----------
  const pad = (n) => String(n).padStart(2, "0");
  window.fmtTime = function (iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  // 相对时间：30 天内用「x 天前」这类扫读友好的形式，更早退回具体日期
  window.relTime = function (iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const diff = Date.now() - d.getTime();
    if (diff < 0) return "刚刚";
    const MIN = 60000, HOUR = 3600000, DAY = 86400000;
    if (diff < MIN) return "刚刚";
    if (diff < HOUR) return Math.floor(diff / MIN) + " 分钟前";
    if (diff < DAY) return Math.floor(diff / HOUR) + " 小时前";
    if (diff < 30 * DAY) return Math.floor(diff / DAY) + " 天前";
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  // 路径中部省略：保留盘符与首尾目录（比尾部截断更有辨识度，且避免 rtl 的 BiDi 重排）
  window.shortPath = function (p, max) {
    const s = String(p || "");
    const limit = max || 46;
    if (s.length <= limit) return s;
    const sep = s.includes("\\") ? "\\" : "/";
    // 保留前导分隔符：/home/… 与 \\wsl.localhost\… 的开头不能被 filter(Boolean) 吃掉
    const leadMatch = /^[\\/]+/.exec(s);
    const lead = leadMatch ? leadMatch[0] : "";
    const parts = s.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 3) return s.slice(0, limit - 1) + "…";
    const head = parts.slice(0, 2).join(sep);
    const tail = parts.slice(-2).join(sep);
    return lead + head + sep + "…" + sep + tail;
  };
  window.fmtSize = function (bytes) {
    if (bytes == null) return "-";
    if (bytes < 1024) return bytes + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(1) + " " + units[i];
  };
  window.fmtNum = function (n) {
    return (n == null) ? "-" : Number(n).toLocaleString("zh-CN");
  };

  // ---------- GitHub 风格热力图：网格构建（首页总览与详情页共用） ----------
  // days: {"YYYY-MM-DD": 次数}；返回 {cols, monthMarks, dayLabels}
  // 列=周（周日起始），行=周日…周六，未来日期留空对齐
  window.buildHeatGrid = function (days, weeks) {
    days = days || {};
    const now = new Date();
    const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const todayKey = key(now);
    // 网格最后一天 = 本周周日；起点 = weeks 周前的周日
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (7 - now.getDay()) % 7);
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 7 * weeks + 1);
    const cols = [];
    const monthMarks = [];
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const col = [];
      for (let r = 0; r < 7; r++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + r);
        if (d > end) { col.push(null); continue; }
        const k = key(d);
        const n = days[k] || 0;
        col.push({
          key: k + "_" + r, date: k, n,
          level: n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 9 ? 3 : 4,
          today: k === todayKey,
          label: `${k}：${n} 次提交`,
        });
      }
      // 月份标签取该列周四（row=4），换月即标记；含未来日期的未满列不标
      if (!col.includes(null)) {
        const mid = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + 4);
        if (mid.getMonth() !== lastMonth) {
          monthMarks.push({ col: w, label: `${mid.getMonth() + 1}月` });
          lastMonth = mid.getMonth();
        }
      }
      cols.push(col);
    }
    return {
      cols, monthMarks,
      dayLabels: [{ row: 1, l: "一" }, { row: 3, l: "三" }, { row: 5, l: "五" }],
    };
  };

  // ---------- 剪贴板 ----------
  window.copyText = async function (text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("路径已复制到剪贴板", "ok");
    } catch (e) {
      // 降级方案：临时 textarea + execCommand
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        toast("路径已复制到剪贴板", "ok");
      } catch (e2) {
        toast("复制失败，请手动复制：" + text, "error");
      }
      ta.remove();
    }
  };

  // ---------- 通用状态徽标样式 ----------
  function statusBadgeClass(s) { return "badge s-" + s; }

  // ---------- 标签语义分色：语言=青绿 框架=紫 工具/其他=中性 ----------
  const TAG_LANGS = new Set([
    "Python", "JavaScript", "TypeScript", "Go", "Rust", "C", "C++", "C#",
    "Java", "Kotlin", "PHP", "Ruby", "Swift", "Dart", "Lua", "Shell", "SQL",
    "Jupyter", "HTML", "CSS", "Conda",
  ]);
  const TAG_FRAMEWORKS = new Set([
    "React", "Vue", "Next.js", "Nuxt", "Svelte", "Angular", "FastAPI",
    "Flask", "Django", "Express", "Koa", "NestJS", "Electron", "Tornado",
    "Scrapy", "Celery", "Qt", "Tailwind CSS", "Ant Design", "Element Plus",
    "Vite", "Webpack", "esbuild", "pytest", "Selenium", "Playwright",
  ]);
  function tagClass(tag) {
    if (TAG_LANGS.has(tag)) return "tag tag-lang";
    if (TAG_FRAMEWORKS.has(tag)) return "tag tag-fw";
    return "tag tag-tool";
  }

  // ---------- git 提交记录分色 ----------
  // Conventional Commits 前缀 → 类型（用于彩色徽章）
  function commitType(msg) {
    const m = /^\s*(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert|merge)\b/i.exec(msg || "");
    return m ? m[1].toLowerCase() : "";
  }
  // 首行去掉类型前缀后的正文
  function commitMsgText(msg) {
    const first = (msg || "").split("\n")[0] || "";
    return first.replace(/^\s*(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert|merge)\b[:：\s]*/i, "").slice(0, 120) || first.slice(0, 120);
  }
  // 贡献者名字 → 稳定取色（哈希散列到调色板，两种主题下都可见）
  const USER_COLORS = ["#0969da", "#1a7f37", "#bf3989", "#bc4c00", "#8250df", "#0f766e"];
  function userColor(name) {
    let h = 0;
    for (const ch of String(name || "?")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return USER_COLORS[h % USER_COLORS.length];
  }

  // ---------- 目录树文件扩展名着色 ----------
  const FILE_HUES = {
    ".py": "#3fb950", ".ipynb": "#f0883e",
    ".js": "#d29922", ".mjs": "#d29922", ".cjs": "#d29922",
    ".ts": "#4493f8", ".tsx": "#4493f8", ".jsx": "#4493f8",
    ".vue": "#3fb950", ".svelte": "#db61a2",
    ".go": "#58a6ff", ".rs": "#f0883e", ".java": "#b083f0",
    ".c": "#8b949e", ".cpp": "#8b949e", ".h": "#8b949e", ".hpp": "#8b949e",
    ".cs": "#4493f8", ".php": "#a371f7", ".rb": "#f85149",
    ".md": "#c4b5fd", ".txt": "#8b949e", ".json": "#d29922",
    ".yml": "#a371f7", ".yaml": "#a371f7", ".toml": "#8b949e",
    ".html": "#f0883e", ".css": "#4493f8", ".scss": "#db61a2",
    ".sql": "#58a6ff", ".sh": "#3fb950", ".bat": "#8b949e",
    ".png": "#a371f7", ".jpg": "#a371f7", ".jpeg": "#a371f7", ".gif": "#a371f7",
    ".svg": "#f0883e", ".ico": "#d29922", ".lock": "#8b949e",
  };
  function fileColor(name) {
    const dot = String(name || "").lastIndexOf(".");
    if (dot < 0) return "var(--muted)";
    return FILE_HUES[String(name).slice(dot).toLowerCase()] || "var(--muted)";
  }

  // ---------- 图标（统一线性 SVG，替代 emoji 与几何符号） ----------
  // 说明：Markdown 工具栏保留 B / I / H2 这类排版惯例文字标，其余一律走图标。
  const ICONS = {
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    "folder-open": '<path d="M4 20h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 4.9A2 2 0 0 0 7.93 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/><path d="M2 14h20l-2.4 4.2a2 2 0 0 1-1.7 1H6.1a2 2 0 0 1-1.7-1L2 14Z"/>',
    terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    // Cursor：等距立方体（其品牌 logo 的几何特征）
    cursor: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    // VS Code 品牌折带形状：实心填充（path 内覆盖 svg 的 fill=none/stroke 默认）
    vscode: '<path fill="currentColor" stroke="none" d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261a1 1 0 0 0 0 1.485L4.03 11.5.327 14.254a1 1 0 0 0 0 1.485l1.322 1.207a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 19.125V4.874a1.5 1.5 0 0 0-.85-1.287zm-5.146 9.591-6.525-4.913a.75.75 0 0 0-.963.043L6.32 11.5l4.196 4.192a.75.75 0 0 0 .963.043l6.525-4.913a.75.75 0 0 0 0-1.25z"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    "chevron-left": '<path d="m15 18-6-6 6-6"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "chevron-up": '<path d="m18 15-6-6-6 6"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    pencil: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    "file-text": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m6.08 9.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59"/><path d="m6.08 14.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.59"/>',
    tag: '<path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42Z"/><circle cx="7.5" cy="7.5" r=".8"/>',
    commit: '<circle cx="12" cy="12" r="3"/><path d="M3 12h6"/><path d="M15 12h6"/>',
    files: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    drive: '<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/><path d="M6 16h.01"/><path d="M10 16h.01"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    zap: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
    "arrow-left": '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    "arrow-up-down": '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/>',
    filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
    code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  };
  window.LpaIcon = {
    name: "LpaIcon",
    props: {
      name: { type: String, required: true },
      size: { type: [Number, String], default: 16 },
      stroke: { type: [Number, String], default: 1.8 },
    },
    computed: {
      inner() { return ICONS[this.name] || ""; },
    },
    template: `<svg class="licon" :width="size" :height="size" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" :stroke-width="stroke" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false" v-html="inner"></svg>`,
  };

  // ---------- 模态框可达性：焦点陷阱 + 滚动锁定 + 焦点归还 ----------
  // 用法：在 .modal 上加 v-modal（配合 v-if，挂载/卸载时自动 lock/unlock）
  const modalStack = [];
  function focusables(root) {
    return [...root.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )].filter(el => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);
  }
  function lockModal(root) {
    document.body.classList.add("modal-open");
    const prev = document.activeElement;
    const onKey = (e) => {
      if (e.key !== "Tab") return;
      const items = focusables(root);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    modalStack.push({ root, prev, onKey });
    const items = focusables(root);
    if (items.length) items[0].focus();
  }
  function unlockModal(root) {
    const i = modalStack.findIndex(m => m.root === root);
    if (i < 0) return;
    const m = modalStack.splice(i, 1)[0];
    document.removeEventListener("keydown", m.onKey, true);
    if (!modalStack.length) document.body.classList.remove("modal-open");
    if (m.prev && document.body.contains(m.prev)) m.prev.focus();
  }
  window.LpaModal = {
    mounted(el) { lockModal(el); },
    unmounted(el) { unlockModal(el); },
  };

  // 模板表达式只能访问组件实例属性（Vue3 编译后为 _ctx.xxx），
  // window 上的工具函数必须通过 globalProperties 注入后模板才能调用
  window.LPA_HELPERS = {
    fmtTime, relTime, shortPath, fmtSize, fmtNum, copyText, statusBadgeClass,
    themeName, cycleTheme, tagClass,
    commitType, commitMsgText, userColor, fileColor,
    editorIcon, editorName,
  };

  // ---------- 自定义下拉组件（替代原生 select：统一样式 + 键盘可达） ----------
  // 用法：<lpa-select v-model="x" :options="['a','b']" all-label="全部" placeholder="…" accent></lpa-select>
  window.LpaSelect = {
    name: "LpaSelect",
    props: {
      modelValue: { type: String, default: "" },
      options: { type: Array, default: () => [] },
      placeholder: { type: String, default: "请选择" },
      allLabel: { type: String, default: "" },   // 传入后在列表顶部加一个空值项（筛选用）
      accent: { type: Boolean, default: false }, // 强调色触发器（如详情页状态）
    },
    emits: ["update:modelValue"],
    data() { return { open: false, focused: 0 }; },
    computed: {
      innerOptions() {
        // 兼容字符串与 {v, l} 对象两种选项形式（如"50 条"这类带说明的项）
        const list = this.options.map(o =>
          typeof o === "string" ? { v: o, label: o } : { v: o.v, label: o.l ?? o.label ?? String(o.v) });
        if (this.allLabel) list.unshift({ v: "", label: this.allLabel });
        return list;
      },
      display() {
        const hit = this.innerOptions.find(o => o.v === this.modelValue);
        return hit ? hit.label : (this.modelValue || this.placeholder);
      },
      isPlaceholder() { return !this.modelValue; },
    },
    methods: {
      toggle() { this.open ? this.close() : this.show(); },
      show() {
        this.open = true;
        const idx = this.innerOptions.findIndex(o => o.v === this.modelValue);
        this.focused = idx >= 0 ? idx : 0;
        setTimeout(() => this.scrollFocused(), 0);
        document.addEventListener("click", this.onDocClick);
      },
      close() {
        this.open = false;
        document.removeEventListener("click", this.onDocClick);
      },
      onDocClick(e) { if (!this.$el.contains(e.target)) this.close(); },
      select(item) {
        this.$emit("update:modelValue", item.v);
        this.close();
      },
      onKeydown(e) {
        if (!this.open) {
          if (["Enter", " ", "ArrowDown"].includes(e.key)) { e.preventDefault(); this.show(); }
          return;
        }
        if (e.key === "Escape") { e.preventDefault(); this.close(); }
        else if (e.key === "ArrowDown") { e.preventDefault(); this.focused = Math.min(this.focused + 1, this.innerOptions.length - 1); this.scrollFocused(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); this.focused = Math.max(this.focused - 1, 0); this.scrollFocused(); }
        else if (e.key === "Enter") { e.preventDefault(); this.select(this.innerOptions[this.focused]); }
        else if (e.key === "Tab") { this.close(); }
      },
      scrollFocused() {
        const list = this.$refs.list;
        if (list && list.children[this.focused]) {
          list.children[this.focused].scrollIntoView({ block: "nearest" });
        }
      },
    },
    beforeUnmount() { document.removeEventListener("click", this.onDocClick); },
    template: `
      <span class="lsel" :class="[{ open, accent }, modelValue ? 'sv-' + modelValue : '']" @keydown="onKeydown">
        <button type="button" class="lsel-trigger" @click="toggle"
                :aria-expanded="open ? 'true' : 'false'" aria-haspopup="listbox">
          <span :class="{ 'lsel-placeholder': isPlaceholder }">{{ display }}</span>
          <span class="lsel-arrow"><svg class="licon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>
        </button>
        <transition name="lsel">
          <span class="lsel-list" role="listbox" v-if="open" ref="list">
            <span v-for="(opt, i) in innerOptions" :key="opt.v || '__all__'" role="option"
                  class="lsel-item" :class="{ sel: opt.v === modelValue, foc: i === focused }"
                  @mouseenter="focused = i"
                  @click.stop="select(opt)">
              <span class="lsel-check"><svg class="licon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></span>
              <span>{{ opt.label }}</span>
            </span>
          </span>
        </transition>
      </span>
    `,
  };
})();
