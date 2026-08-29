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

  // 模板表达式只能访问组件实例属性（Vue3 编译后为 _ctx.xxx），
  // window 上的工具函数必须通过 globalProperties 注入后模板才能调用
  window.LPA_HELPERS = {
    fmtTime, fmtSize, fmtNum, copyText, statusBadgeClass, toggleTheme,
  };
})();
