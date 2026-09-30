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
  // 可选复选框：opts.checkbox = { label, checked }，确认时返回 { ok:true, checked }；
  // 不传 checkbox 时返回值仍是布尔 true（保持既有调用方语义不变）。
  window.confirmDialog = function (message, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      const esc = s => String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      // requireText：需在弹窗内输入指定文本才能确认（危险操作防误触，替代原生 prompt）
      const needText = opts.requireText != null;
      const hasCheck = !!opts.checkbox;
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
          <label class="confirm-check" style="display:none">
            <input type="checkbox" class="c-check">
            <span class="c-check-label"></span>
          </label>
          <div class="actions">
            <button type="button" class="btn c-cancel">${esc(opts.cancelText || "取消")}</button>
            <button type="button" class="btn ${opts.danger ? "danger-solid" : "primary"} c-ok">${esc(opts.okText || "确定")}</button>
          </div>
        </div>`;
      mask.querySelector(".confirm-msg").textContent = message;  // textContent 防注入
      const okBtn = mask.querySelector(".c-ok");
      const inputRow = mask.querySelector(".confirm-input-row");
      const input = mask.querySelector(".c-input");
      const checkRow = mask.querySelector(".confirm-check");
      const check = mask.querySelector(".c-check");
      if (hasCheck) {
        checkRow.style.display = "";
        check.checked = !!opts.checkbox.checked;
        mask.querySelector(".c-check-label").textContent = opts.checkbox.label || "";
      }
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
      // 确认结果：带复选框时把勾选状态一并返回（调用方据此决定执行方式）
      const confirmValue = () => {
        if (needText) return input.value;
        return hasCheck ? { ok: true, checked: check.checked } : true;
      };
      const onKey = e => {
        if (e.key === "Escape") { e.stopPropagation(); done(false); return; }
        // 输入模式下回车 = 尝试确认（值不匹配时按钮禁用，回车无效果）
        if (e.key === "Enter" && needText && input.value === opts.requireText) { e.stopPropagation(); done(input.value); }
      };
      document.addEventListener("keydown", onKey, true);
      mask.querySelector(".c-cancel").onclick = () => done(false);
      okBtn.onclick = () => done(confirmValue());
      mask.addEventListener("mousedown", e => { if (e.target === mask) done(false); });
      document.body.appendChild(mask);
      // 默认焦点：危险操作聚焦「取消」，防止用户随手回车直接执行删除；
      // 输入确认模式聚焦输入框，普通确认聚焦「确定」保持高效
      const cancelBtn = mask.querySelector(".c-cancel");
      (needText ? input : (opts.danger ? cancelBtn : okBtn)).focus();
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
      toast("无法连接本地服务，请尝试重启应用", "error");
      throw e;
    }
    let data = null;
    try { data = await resp.json(); } catch (e) { /* 空响应 */ }
    if (!resp.ok) {
      // 422 校验错误的 detail 是对象数组，直接显示会变成 [object Object]
      const d = data && data.detail;
      let msg;
      if (typeof d === "string") msg = d;
      else if (d && typeof d === "object" && !Array.isArray(d) && typeof d.message === "string") msg = d.message;
      else if (Array.isArray(d) && d.length) msg = d[0].msg || d[0].loc && `字段 ${d[0].loc.join(".")} 无效`;
      msg = msg || `请求失败（HTTP ${resp.status}）`;
      if (!opt.silent) toast(msg, "error");
      const err = new Error(msg);
      err.status = resp.status;
      err.data = data;   // 结构化 detail（如重复项目列表）供调用方精细处理
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
  // label：提示文案中的内容名（默认「路径」），复制 README 原文等非路径内容时传入
  window.copyText = async function (text, label) {
    const what = label || "路径";
    try {
      await navigator.clipboard.writeText(text);
      toast(what + "已复制到剪贴板", "ok");
    } catch (e) {
      // 降级方案：临时 textarea + execCommand
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        toast(what + "已复制到剪贴板", "ok");
      } catch (e2) {
        toast("复制失败，请手动复制：" + text, "error");
      }
      ta.remove();
    }
  };

  // ---------- 文件下载（fetch + blob） ----------
  // 不用 location.href 触发下载：接口报错（500 等）时浏览器会把整个 WebView
  // 导航到错误 JSON 页，应用界面被替换且没有返回入口。先 fetch 验证响应，
  // 成功再以 blob + a[download] 落盘，失败只弹 toast。
  window.downloadFile = async function (url, fallbackName) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        let detail = "";
        try { const j = await resp.json(); detail = j.detail || ""; } catch (e) { /* 非 JSON 错误体 */ }
        throw new Error(detail || ("HTTP " + resp.status));
      }
      const blob = await resp.blob();
      // 文件名优先取后端 Content-Disposition，取不到用调用方给的兜底名
      let name = fallbackName || "download";
      const cd = resp.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
      if (m) {
        try { name = decodeURIComponent(m[1].replace(/"/g, "")); }
        catch (e) { name = m[1].replace(/"/g, ""); }
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return true;
    } catch (e) {
      toast("导出失败：" + (e.message || "未知错误"), "error");
      return false;
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
  // Conventional Commits 白名单。**必须与后端 gitinfo._KNOWN_TYPES 保持一致**，
  // 否则前端筛选出来的类型与 /commit-stats 的类型分布会对不上号（改一边就要改另一边）。
  const COMMIT_TYPES = ["feat", "fix", "docs", "style", "refactor", "perf",
                        "test", "chore", "build", "ci", "revert", "merge"];
  const COMMIT_TYPE_RE = new RegExp("^\\s*(" + COMMIT_TYPES.join("|") + ")\\b", "i");
  // 未登记前缀：形如 `design: xxx` / `security：xxx`，与后端 _PREFIX_RE 同一规则。
  // 本项目作者实际在用 design:/security:/init: 这类自造前缀，若只认白名单，
  // 这些提交会既没有徽章、也无法被类型筛选命中。
  const COMMIT_PREFIX_RE = /^\s*([a-z][a-z0-9_-]{1,14})\s*[:：]\s*\S/i;

  // 首行 → 类型。纯前缀口径，与后端 /commit-stats 的分类规则相同：
  //   白名单命中 → 该类型；未登记前缀 → 以前缀名本身成类；都没有 → ""（调用方按 plain/other 处理）
  // 注意：这里只统一「怎么分类」，不统一「统计多少条」——chips 统计的是已加载的
  // 时间线条目（它就是列表筛选器），分析块统计的是全量，两者范围不同且各自在界面上标明。
  function commitType(msg) {
    const text = msg || "";
    const m = COMMIT_TYPE_RE.exec(text);
    if (m) return m[1].toLowerCase();
    const p = COMMIT_PREFIX_RE.exec(text);
    return p ? p[1].toLowerCase() : "";
  }
  // 类型 → 徽章 CSS 类。白名单外的自造前缀统一落到 ct-unknown，
  // 避免出现有类型名却没有对应样式（裸露成无底色）的徽章。
  function commitTypeClass(t) {
    if (!t) return "ct-plain";
    return COMMIT_TYPES.indexOf(t) >= 0 || t === "other" ? "ct-" + t : "ct-unknown";
  }
  // 首行去掉类型前缀后的正文（白名单前缀 + 未登记前缀都去掉，与徽章显示的语义一致）
  const COMMIT_STRIP_RE = new RegExp(
    "^\\s*(?:" + COMMIT_TYPES.join("|") + ")\\b[:：\\s]*"
    + "|^\\s*[a-z][a-z0-9_-]{1,14}\\s*[:：]\\s*", "i");
  function commitMsgText(msg) {
    const first = (msg || "").split("\n")[0] || "";
    return first.replace(COMMIT_STRIP_RE, "").slice(0, 120) || first.slice(0, 120);
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

  // ---------- 重复项目命中依据 → 中文（与后端 duplicates.py 的 reasons 对应） ----------
  const DUP_REASON_LABELS = { path: "同路径", name: "同名", remote: "同一 Git 远端" };
  function dupReasonText(reasons) {
    return (reasons || []).map(r => DUP_REASON_LABELS[r] || r).join(" / ");
  }
  window.dupReasonText = dupReasonText;

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
    // 停止运行（运行历史里结束捕获进程）
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
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
    commitType, commitMsgText, commitTypeClass, userColor, fileColor,
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

  // ---------- 项目轻量列表（/api/projects/brief）共享缓存 ----------
  // 谁在用：详情页顶栏的「上一个 / 下一个项目」箭头、顶部标签栏的名称与别名字典。
  // 为什么要缓存：详情页的箭头位置由兄弟项目列表算出，若等异步请求回来才渲染，
  // 软导航切换项目时会先渲染成「没有箭头」、数据到了箭头再冒出来，
  // 顶栏内容整体左右跳一下（实测抖动约 30ms）。common.js 是外壳脚本、
  // 软导航时不会重跑，把最近一次结果挂在这里，页面脚本重建时就能同步拿到，
  // 首帧即为正确状态，切换过程没有任何中间态。
  let briefList = [];
  let briefPending = null;

  function briefSync() { return briefList; }

  function refreshBrief() {
    if (!briefPending) {
      briefPending = api("/api/projects/brief", { silent: true })
        .then(b => {
          briefList = ((b && b.projects) || []).map(p => ({
            id: p.id, name: p.name, alias: p.alias || "",
          }));
          return briefList;
        })
        .catch(() => briefList)          // 拿不到就沿用上次缓存，不打断页面
        .finally(() => { briefPending = null; });
    }
    return briefPending;
  }

  window.lpaBriefSync = briefSync;       // 同步读最近一次结果（页面 data() 里用）
  window.lpaRefreshBrief = refreshBrief; // 异步刷新（同一 tick 内多次调用只发一次请求）

  // ---------- 页面内跳转的统一出口：同文档软导航 ----------
  // 背景：本应用是两个独立文档（/ 与 /project/N）。早期点标签直接 location.href，
  // 每切一次项目都要「卸载文档 → 重新下载解析 HTML → 重新加载 Vue → 再拉接口」，
  // 表现出来就是整页闪一下、顶部栏跟着重建。
  //
  // 这里改成同文档切换：
  //   · 标签栏挂在 #app 之外（.tabbar-slot），切换时它不重建，顶部区域完全稳定；
  //   · 只替换 #app 的内容，并按需重新执行该页的脚本（dashboard.js / project.js），
  //     拿到一份全新的 IIFE 作用域，页面逻辑与整页加载时完全一致；
  //   · 页面外壳（#app 模板 + 脚本源码）与具体项目无关，取一次缓存复用，
  //     之后切项目是纯 DOM 操作，没有网络与解析开销；
  //   · 任何一步失败都回退到整页跳转（localStorage 里 lpa-soft-nav="0" 可强制关闭），
  //     所以最坏情况等于改动前的行为，不会白屏卡死。
  const SOFT_NAV_KEY = "lpa-soft-nav";
  const PAGE_HOME = "home";
  const PAGE_PROJECT = "project";

  // common.js 执行时解析器只走到本文件，此刻页面上已有的 <script src> 就是「外壳脚本」
  // （vue / common / settings）。页面脚本永远不在其中，所以每次切换都要重新执行一遍。
  const SHELL_SCRIPTS = new Set(
    [...document.querySelectorAll("script[src]")].map(el => el.getAttribute("src")));

  const shellCache = new Map();    // 'home' | 'project' → { title, appHTML, scripts }
  const scriptCache = new Map();   // 脚本地址 → 源码
  let navToken = 0;                // 连点多个标签时，只让最后一次导航生效

  function pathOf(url) {
    try { return new URL(url, location.origin).pathname; }
    catch (e) { return null; }
  }
  function pageTypeOf(url) {
    const p = pathOf(url);
    if (p === null) return null;
    if (p === "/" || p === "") return PAGE_HOME;
    return /^\/project\/\d+\/?$/.test(p) ? PAGE_PROJECT : null;
  }
  function projectIdOf(url) {
    const m = /^\/project\/(\d+)\/?$/.exec(pathOf(url) || "");
    return m ? Number(m[1]) : null;
  }
  function hardNavigate(url) { location.href = url; }

  async function fetchText(url) {
    const resp = await fetch(url, { credentials: "same-origin" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
    return resp.text();
  }

  // 取页面外壳：模板 + 该页脚本源码，一次备齐并缓存。
  // 外壳与具体项目无关（只有 <title> 与 #app 模板，都是静态的），
  // 所以只有第一次切到某类页面会真的发请求，之后是纯 DOM 操作。
  // /project/0 只是用来拿模板：该路由不校验 id，也不查库。
  async function loadShell(type) {
    if (shellCache.has(type)) return shellCache.get(type);
    const html = await fetchText(type === PAGE_HOME ? "/" : "/project/0");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const root = doc.getElementById("app");
    if (!root) throw new Error("页面缺少 #app 容器");
    const scripts = [];
    for (const src of [...doc.querySelectorAll("script[src]")]
      .map(el => el.getAttribute("src"))
      .filter(src => src && !SHELL_SCRIPTS.has(src))) {
      if (!scriptCache.has(src)) scriptCache.set(src, await fetchText(src));
      scripts.push({ src: src, text: scriptCache.get(src) });
    }
    const shell = {
      title: (doc.querySelector("title") || {}).textContent || document.title,
      appHTML: root.innerHTML,
      scripts: scripts,
    };
    shellCache.set(type, shell);
    return shell;
  }

  // 内联脚本插入即同步执行，所以挂完就能立刻判断页面有没有挂载成功
  function runScriptText(src, text) {
    const el = document.createElement("script");
    el.textContent = text + "\n//# sourceURL=" + src;   // 便于 DevTools 里定位
    document.body.appendChild(el);
    el.remove();
  }

  // 「换掉 #app → 执行页面脚本 → 挂载」必须全程同步。
  // 中间一旦出现 await，浏览器就会插进一帧——那一帧 #app 还带着 v-cloak（display:none），
  // 内容区会空一下，正是这次要消灭的那种闪烁。所以资源在 loadShell 里就全部备好了。
  function mountPage(shell) {
    const prev = document.getElementById("app");
    if (!prev) throw new Error("找不到 #app 容器");
    const next = document.createElement("div");
    next.id = "app";
    next.setAttribute("v-cloak", "");
    next.innerHTML = shell.appHTML;
    prev.replaceWith(next);
    for (const s of shell.scripts) runScriptText(s.src, s.text);
    // 页面脚本挂载后会写 window.__lpaPageApp；没写说明它没跑起来
    if (!window.__lpaPageApp) {
      throw new Error("页面脚本未完成挂载：" + shell.scripts.map(s => s.src).join("、"));
    }
    document.title = shell.title;
  }

  async function softNavigate(url, opts) {
    opts = opts || {};
    if (localStorage.getItem(SOFT_NAV_KEY) === "0") { hardNavigate(url); return; }
    const type = pageTypeOf(url);
    if (!type) { hardNavigate(url); return; }
    const my = ++navToken;
    try {
      const shell = await loadShell(type);     // 唯一的 await：只做资源准备，不动 DOM
      if (my !== navToken) return;             // 期间又点了别的标签，放弃本次
      if (!opts.fromPop && history.state && history.state.lpa) {
        // 记下当前页的滚动位置，供浏览器「后退」时恢复
        history.replaceState({ lpa: 1, scroll: window.scrollY }, "", location.pathname);
      }
      const prev = window.__lpaPageApp;
      window.__lpaPageApp = null;
      window.LPA_OPEN_SETTINGS = null;         // 首页专属入口，切走后必须失效
      window.lpaNavigate = softNavigate;       // 详情页 mounted 里会再覆盖成 leaveConfirm
      if (prev && typeof prev.unmount === "function") {
        try { prev.unmount(); } catch (e) { /* 已经卸过了 */ }
      }
      if (!opts.fromPop) history.pushState({ lpa: 1, scroll: 0 }, "", url);
      mountPage(shell);
      window.scrollTo(0, opts.restoreScroll || 0);
      window.dispatchEvent(new CustomEvent("lpa-route-changed", {
        detail: { url: url, projectId: projectIdOf(url) },
      }));
    } catch (err) {
      console.warn("[lpa] 软导航失败，回退整页跳转：", err);
      if (my === navToken) hardNavigate(url);
    }
  }

  window.lpaSoftNavigate = softNavigate;
  // 页面内跳转的统一出口。详情页会把它换成带「未保存内容」确认的版本
  // （见 project.js 的 leaveConfirm），标签栏与其它共享组件一律走这里，就不会绕过那道确认。
  window.lpaNavigate = softNavigate;
  // pushState 只换了地址栏，前进/后退必须自己把内容换回去
  window.addEventListener("popstate", (e) => {
    softNavigate(location.pathname, {
      fromPop: true,
      restoreScroll: (e.state && e.state.scroll) || 0,
    });
  });

  // ---------- 顶部项目标签栏（浏览器式：在多个最近项目之间快速切换） ----------
  // 设计口径：
  //   · 第一个标签固定为「首页」（全部项目），不可关闭，相当于浏览器的主页标签；
  //   · 项目标签在你进入详情页时追加到末尾（不打乱你手动拖出来的顺序），
  //     顺序完全由你决定：拖动排序、× / 中键关闭，关当前标签时自动切到相邻标签；
  //   · 顺序存在本机 localStorage["lpa-tabs"]，刷新、重启后都保持；
  //   · 标签只记在本机：换浏览器 / 清缓存即重来，不写档案库、不进导出备份；
  //   · 首次使用（本机还没有标签记录）时用后端「最近开发」预填，打开就有东西可切。
  const TAB_KEY = "lpa-tabs";
  const TABBAR_HIDDEN_KEY = "lpa-tabbar-hidden";

  function tabbarVisible() {
    return localStorage.getItem(TABBAR_HIDDEN_KEY) !== "1";
  }
  window.lpaTabbarVisible = tabbarVisible;
  // 设置弹窗里切换标签栏显隐；写 localStorage 后广播事件，标签栏自身即时响应
  window.setLpaTabbarVisible = function (on) {
    try { localStorage.setItem(TABBAR_HIDDEN_KEY, on ? "0" : "1"); }
    catch (e) { /* 隐私模式等写不了，忽略即可 */ }
    window.dispatchEvent(new Event("lpa-prefs-changed"));
  };

  // 当前页面对应的项目 id（详情页才有；首页为 null）
  function currentProjectId() {
    const m = /^\/project\/(\d+)\/?$/.exec(location.pathname);
    return m ? Number(m[1]) : null;
  }

  window.LpaTabbar = {
    name: "LpaTabbar",
    data() {
      return {
        tabs: [],                       // 已打开的项目标签 [{id, name, alias}]，数组顺序 = 显示顺序
        recent: [],                     // 后端「最近开发」列表（▾ 下拉用）
        names: {},                      // id → {name, alias} 字典（/api/projects/brief）
        visible: tabbarVisible(),
        moreOpen: false,
        curId: currentProjectId(),
        dragId: null,                   // 正在拖拽的标签 id（null = 没在拖）
        xPressed: false,                // 从 × 起手 → 本次不启动拖拽
      };
    },
    computed: {
      hasTabs() { return this.tabs.length > 0; },
    },
    methods: {
      go(url) { window.lpaNavigate(url); },
      openHome() { if (this.curId !== null) this.go("/"); },
      openTab(t) { if (t.id !== this.curId) this.go("/project/" + t.id); },
      hasTab(id) { return this.tabs.some(t => t.id === id); },
      nameOf(id) { return (this.names[id] && this.names[id].name) || ("项目 #" + id); },
      aliasOf(id) { return (this.names[id] && this.names[id].alias) || ""; },
      // 标签悬浮提示：项目名称 + 别名（别名只在有值时出现，不再夹带拖拽/关闭说明）
      tabTitle(t) { return t.alias ? t.name + "\n别名：" + t.alias : t.name; },
      // 打开「最近项目」下拉里的一项：目标页会把它登记成标签
      openRecent(p) {
        this.moreOpen = false;
        if (p.id !== this.curId) this.go("/project/" + p.id);
      },
      // 关闭标签：关掉当前标签时按浏览器习惯切到相邻标签（没有就回首页），
      // 而不是把人留在一个已经没有标签的页面上。
      closeTab(t, ev) {
        if (ev) { ev.stopPropagation(); ev.preventDefault(); }
        const idx = this.tabs.findIndex(x => x.id === t.id);
        if (idx < 0) return;
        this.tabs.splice(idx, 1);
        this.persist();
        if (t.id !== this.curId) { this.afterTabsChange(); return; }
        const next = this.tabs[idx] || this.tabs[idx - 1] || null;
        this.go(next ? "/project/" + next.id : "/");
      },
      // 档案被删除后同步摘掉对应标签（详情页删档时调用，见 window.lpaForgetTab）
      forget(id) {
        const idx = this.tabs.findIndex(t => t.id === id);
        if (idx < 0) return;
        this.tabs.splice(idx, 1);
        this.persist();
        this.afterTabsChange();
      },
      async closeAll() {
        this.moreOpen = false;
        const onProject = this.curId !== null;
        this.tabs = [];
        this.persist();
        toast("已关闭全部项目标签", "ok");
        if (onProject) this.go("/");
      },
      afterTabsChange() { this.$nextTick(() => this.scrollActiveIntoView()); },
      // 滚轮直接横向滚动标签条（浏览器标签栏同款手感）；
      // 标签没溢出时不动手，让页面正常滚动。
      onWheel(e) {
        const el = this.$refs.strip;
        if (!el || el.scrollWidth <= el.clientWidth) return;
        e.preventDefault();
        el.scrollLeft += (e.deltaY || e.deltaX);
      },
      onDocClick(e) { if (!this.$el.contains(e.target)) this.moreOpen = false; },
      onDocMouseUp() { this.xPressed = false; },
      onPrefsChanged() {
        this.visible = tabbarVisible();
        this.syncOffset();
      },
      // 标签栏占位高度同步给 CSS 变量：顶栏、目录树、toast 的 sticky 偏移都据此下移
      syncOffset() {
        document.documentElement.classList.toggle("has-tabbar", this.visible);
      },
      parse(raw) {
        try {
          const arr = JSON.parse(raw);
          if (!Array.isArray(arr)) return [];
          const seen = new Set();
          return arr.filter(t => {
            const id = Number(t && t.id);
            if (!Number.isInteger(id) || id <= 0 || seen.has(id)) return false;
            seen.add(id);
            return true;
          }).map(t => ({
            id: Number(t.id),
            name: String(t.name || ("项目 #" + t.id)),
            alias: String(t.alias || ""),
          }));
        } catch (e) { return []; }
      },
      persist() {
        try { localStorage.setItem(TAB_KEY, JSON.stringify(this.tabs)); }
        catch (e) { /* 写不了就算了，标签退化为本次会话有效 */ }
      },
      // 把当前标签滚进可视区。只动标签条的横向滚动——
      // scrollIntoView 会把整个页面纵向滚动到顶（标签栏是 sticky 在页面顶部），
      // 那样每次切标签页面都会自己跳回顶部，必须手算。
      scrollActiveIntoView() {
        const strip = this.$refs.strip;
        const el = strip && strip.querySelector(".tab.on");
        if (!el) return;
        const sr = strip.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        if (er.left < sr.left) strip.scrollLeft -= (sr.left - er.left) + 8;
        else if (er.right > sr.right) strip.scrollLeft += (er.right - sr.right) + 8;
      },
      // ---- 软导航后的路由同步（common.js 的 softNavigate 广播 lpa-route-changed）----
      onRouteChanged(e) {
        const detail = (e && e.detail) || {};
        this.curId = detail.projectId != null ? detail.projectId : currentProjectId();
        if (this.curId !== null && !this.hasTab(this.curId)) {
          // 新打开的项目追加到末尾：不打乱用户手动拖出来的顺序
          this.tabs.push({
            id: this.curId,
            name: this.nameOf(this.curId),
            alias: this.aliasOf(this.curId),
          });
        }
        // 每次切页都刷一遍字典（只查库、开销可忽略），保证悬浮提示的名称/别名不是旧值
        this.ensureNames();
        this.persist();
        this.afterTabsChange();
      },
      // 名称与别名字典：brief 只查库、不做磁盘校验，开销可忽略。
      // 走共享缓存，与详情页的「兄弟项目」列表共用一次请求（见 refreshBrief）。
      async ensureNames() {
        try {
          const list = await refreshBrief();
          const map = {};
          list.forEach(p => { map[p.id] = { name: p.name, alias: p.alias || "" }; });
          this.names = map;
          this.tabs.forEach(t => {
            if (!map[t.id]) return;
            t.name = map[t.id].name;
            t.alias = map[t.id].alias;
          });
        } catch (e) { /* 名称拿不到就先用「项目 #id」兜底 */ }
      },
      // 详情页保存档案（改名 / 改别名）后刷新字典，标签悬浮提示不留旧值
      onProjectUpdated() { this.ensureNames(); },
      // ---- 拖拽排序：HTML5 DnD，实时换位，未引入任何拖拽库 ----
      onDragStart(t, ev) {
        // 用掉即清：鼠标在窗口外松开时 mouseup 收不到，标记会卡住
        const fromX = this.xPressed;
        this.xPressed = false;
        if (fromX) { ev.preventDefault(); return; }   // 从 × 起手不拖标签
        this.dragId = t.id;
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = "move";
          ev.dataTransfer.setData("text/plain", String(t.id)); // 少了这行部分浏览器不启动拖拽
        }
      },
      onDragOver(t, ev) {
        if (this.dragId == null) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
        if (t.id === this.dragId) return;
        const from = this.tabs.findIndex(x => x.id === this.dragId);
        const to = this.tabs.findIndex(x => x.id === t.id);
        if (from < 0 || to < 0) return;
        // 指针越过目标标签的中线才换位，避免在边界上左右抖动
        const r = ev.currentTarget.getBoundingClientRect();
        let target = (ev.clientX - r.left) > r.width / 2 ? to + 1 : to;
        if (target > from) target -= 1;
        if (target === from) return;
        this.tabs.splice(target, 0, this.tabs.splice(from, 1)[0]);
      },
      onStripDragOver(ev) { if (this.dragId != null) ev.preventDefault(); },
      onStripDrop(ev) { ev.preventDefault(); this.onDragEnd(); },
      onDragEnd() {
        if (this.dragId == null) return;
        this.dragId = null;
        this.persist();     // 拖完立刻落盘，刷新后顺序不变
      },
      async init() {
        // 1) 名称字典：用它同步改名，并清理已删档案留下的标签
        await this.ensureNames();
        const hasNames = Object.keys(this.names).length > 0;

        // 2) 最近开发列表：既用于「更多」下拉，也用于首次使用的预填
        try {
          const r = await api("/api/projects/recent?limit=8", { silent: true });
          this.recent = r.projects || [];
        } catch (e) { this.recent = []; }

        const stored = localStorage.getItem(TAB_KEY);
        let tabs = stored === null
          ? this.recent.map(p => ({ id: p.id, name: p.name, alias: this.aliasOf(p.id) }))  // 首次使用：预填
          : this.parse(stored);

        if (hasNames) {
          tabs = tabs.filter(t => this.names[t.id] != null);      // 档案已删除 → 标签自动清理
          tabs.forEach(t => {
            if (!this.names[t.id]) return;
            t.name = this.names[t.id].name;
            t.alias = this.names[t.id].alias;
          });
        }

        // 3) 当前项目若还没有标签，追加到末尾。
        //    刻意不做「置顶」：标签顺序由用户拖拽决定，自动重排会让拖好的顺序在刷新后失效。
        if (this.curId !== null && !tabs.some(t => t.id === this.curId)) {
          tabs.push({ id: this.curId, name: this.nameOf(this.curId), alias: this.aliasOf(this.curId) });
        }

        this.tabs = tabs;
        this.persist();
        this.afterTabsChange();
      },
    },
    async mounted() {
      this.syncOffset();
      document.addEventListener("click", this.onDocClick);
      document.addEventListener("mouseup", this.onDocMouseUp);
      window.addEventListener("lpa-prefs-changed", this.onPrefsChanged);
      window.addEventListener("lpa-route-changed", this.onRouteChanged);
      window.addEventListener("lpa-project-updated", this.onProjectUpdated);
      await this.init();
    },
    beforeUnmount() {
      document.removeEventListener("click", this.onDocClick);
      document.removeEventListener("mouseup", this.onDocMouseUp);
      window.removeEventListener("lpa-prefs-changed", this.onPrefsChanged);
      window.removeEventListener("lpa-route-changed", this.onRouteChanged);
      window.removeEventListener("lpa-project-updated", this.onProjectUpdated);
      document.documentElement.classList.remove("has-tabbar");
    },
    template: `
      <nav class="tabbar" v-if="visible" aria-label="已打开的项目">
        <div class="tab-strip" ref="strip" role="tablist"
             :class="{ dragging: dragId != null }"
             @wheel="onWheel" @dragover="onStripDragOver" @drop="onStripDrop">
          <div class="tab tab-home" role="tab" tabindex="0"
               :class="{ on: curId === null }"
               :aria-selected="curId === null ? 'true' : 'false'"
               title="首页：全部项目" @click="openHome"
               @keydown.enter.prevent="openHome" @keydown.space.prevent="openHome">
            <lpa-icon name="layers" :size="14"></lpa-icon>
            <span class="tab-label">首页</span>
          </div>
          <!-- transition-group 不写 tag：不额外包一层元素，标签仍是 .tab-strip 的直接子元素。
               它的 FLIP 位移就是拖拽时「旁边标签滑开让位」的动画来源（见 .tab-move-move）。 -->
          <transition-group name="tab-move">
            <div class="tab" role="tab" tabindex="0" v-for="t in tabs" :key="t.id"
                 :class="{ on: t.id === curId, dragging: t.id === dragId }"
                 :aria-selected="t.id === curId ? 'true' : 'false'"
                 draggable="true"
                 :title="tabTitle(t)"
                 @click="openTab(t)" @keydown.enter.prevent="openTab(t)"
                 @keydown.space.prevent="openTab(t)"
                 @auxclick.middle.prevent="closeTab(t)"
                 @dragstart="onDragStart(t, $event)"
                 @dragover="onDragOver(t, $event)"
                 @drop.prevent="onDragEnd" @dragend="onDragEnd">
              <lpa-icon name="folder" :size="13"></lpa-icon>
              <span class="tab-label">{{ t.name }}</span>
              <span class="tab-x" role="button" tabindex="0"
                    :aria-label="'关闭 ' + t.name + ' 标签'"
                    @mousedown="xPressed = true"
                    @click.stop="closeTab(t)" @keydown.enter.stop.prevent="closeTab(t)"
                    @keydown.space.stop.prevent="closeTab(t)">
                <lpa-icon name="x" :size="12"></lpa-icon>
              </span>
            </div>
          </transition-group>
        </div>
        <span class="tab-more-wrap">
          <button type="button" class="tab-more" @click.stop="moreOpen = !moreOpen"
                  :class="{ on: moreOpen }" aria-haspopup="menu"
                  :aria-expanded="moreOpen ? 'true' : 'false'"
                  title="最近项目：快速打开其它项目">
            <lpa-icon name="chevron-down" :size="14"></lpa-icon>
          </button>
          <span class="tab-more-list" v-if="moreOpen" role="menu">
            <span class="tm-head">最近项目</span>
            <button type="button" class="tm-item" role="menuitem" v-for="p in recent"
                    :key="'r' + p.id" :class="{ open: hasTab(p.id) }"
                    :title="p.path" @click="openRecent(p)">
              <span class="tm-name">{{ p.name }}</span>
              <span class="tm-path">{{ shortPath(p.path, 42) }}</span>
              <span class="tm-flag" v-if="hasTab(p.id)">已打开</span>
            </button>
            <span class="tm-empty" v-if="!recent.length">暂无最近项目</span>
            <span class="tm-sep" v-if="hasTabs"></span>
            <button type="button" class="tm-item tm-close-all" role="menuitem"
                    v-if="hasTabs" @click="closeAll">
              <lpa-icon name="x" :size="13"></lpa-icon>关闭全部项目标签
            </button>
          </span>
        </span>
      </nav>
    `,
  };

  // ---------- 标签栏独立挂载 ----------
  // 挂在 #app 之外的 .tabbar-slot 上：软导航只替换 #app，标签栏自身不重建，
  // 所以切项目时顶部完全不动，也不会丢掉「最近项目」下拉等界面状态。
  (function mountTabbar() {
    const slot = document.getElementById("tabbar-root");
    if (!slot) return;                       // 老页面没有挂载点就跳过，不报错
    const app = Vue.createApp(window.LpaTabbar);
    app.component("lpa-icon", window.LpaIcon);
    Object.assign(app.config.globalProperties, window.LPA_HELPERS);
    const vm = app.mount(slot);
    // 详情页删档后调用，同步摘掉对应标签（否则会留下一个点不开的死标签）
    window.lpaForgetTab = function (id) {
      if (vm && typeof vm.forget === "function") vm.forget(Number(id));
    };
  })();
})();
