/* 公共工具：主题切换、API 封装、Toast、格式化 */
(function () {
  "use strict";

  // ---------- 主题 ----------
  const THEME_KEY = "lpa-theme";
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem(THEME_KEY, t);
  }
  // 初始化：localStorage 优先，否则跟随系统
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) {
    applyTheme(saved);
  } else {
    applyTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  window.toggleTheme = function () {
    const cur = document.documentElement.getAttribute("data-theme");
    applyTheme(cur === "dark" ? "light" : "dark");
  };

  // ---------- Toast ----------
  let toastBox = null;
  function ensureToastBox() {
    if (!toastBox) {
      toastBox = document.createElement("div");
      toastBox.className = "toasts";
      document.body.appendChild(toastBox);
    }
    return toastBox;
  }
  window.toast = function (msg, type) {
    const box = ensureToastBox();
    const el = document.createElement("div");
    el.className = "toast " + (type || "");
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), type === "error" ? 5000 : 2600);
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
      const msg = (data && data.detail) ? data.detail : `请求失败（HTTP ${resp.status}）`;
      if (!opt.silent) toast(msg, "error");
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    return data;
  };

  // ---------- 格式化 ----------
  window.fmtTime = function (iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

  // 模板表达式只能访问组件实例属性（Vue3 编译后为 _ctx.xxx），
  // window 上的工具函数必须通过 globalProperties 注入后模板才能调用
  window.LPA_HELPERS = {
    fmtTime, fmtSize, fmtNum, copyText, statusBadgeClass, toggleTheme, tagClass,
    commitType, commitMsgText, userColor,
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
        const list = this.options.map(o => ({ v: o, label: o }));
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
          <span class="lsel-arrow">▾</span>
        </button>
        <transition name="lsel">
          <span class="lsel-list" role="listbox" v-if="open" ref="list">
            <span v-for="(opt, i) in innerOptions" :key="opt.v || '__all__'" role="option"
                  class="lsel-item" :class="{ sel: opt.v === modelValue, foc: i === focused }"
                  @mouseenter="focused = i"
                  @click.stop="select(opt)">
              <span class="lsel-check">✓</span>
              <span>{{ opt.label }}</span>
            </span>
          </span>
        </transition>
      </span>
    `,
  };
})();
