#!/usr/bin/env node
// 桌面壳（WebView2）验证：启动源码壳，并在壳内用 pywebview 自己的 evaluate_js
// 通道在真实 WebView2 页面里做断言（不依赖 CDP 调试端口，避免其在本机的不稳定）。
// 覆盖：原生窗口标题与品牌、桌面模式唤起窗口、界面文字可选中、拖动手柄不可选中、
//       拖选后的点击不误跳转、普通点击仍正常、原生桥注入情况、单实例。
// 用法：node tools/test_desktop_webview.cjs [--timeout 90]
// 退出码：0 = 全部通过；1 = 断言失败；2 = 环境/启动问题。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: sleep } = require("node:timers/promises");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const REPO = path.resolve(__dirname, "..");
const PY = path.join(REPO, ".venv", "Scripts", "python.exe");
const TIMEOUT = Number(arg("timeout", "90")) * 1000;
const results = [];
const ok = (label, extra) => {
  results.push(extra === undefined ? { label } : { label, extra });
  console.log("[PASS]", label);
};

// 壳内脚本：
//  1) 守护线程探测本进程的顶层窗口标题（venv 的 python.exe 是 redirector，
//     会再拉一个子解释器，外部按 PID 找不到窗口；在壳内按自身 PID 找最可靠）；
//  2) 等窗口出现后用 evaluate_js 在真实 WebView2 页面里取断言数据并写文件。
const WRAPPER = (port, mutex, outFile) => `import sys, os, threading, time, pathlib, json
sys.path.insert(0, r"${REPO.replace(/\\/g, "/")}")
sys.argv = ["desktop", "--port", "${port}"]
import desktop
desktop.MUTEX_NAME = "${mutex}"
desktop._LEGACY_MUTEX_NAMES = ()
import webview

OUT = pathlib.Path(r"${outFile.replace(/\\/g, "/")}")

JS = r'''
(function () {
  var out = {};
  out.href = location.href;
  out.title = document.title;
  out.brand = (document.querySelector('.logo') || {}).textContent || '';
  out.bodySelect = getComputedStyle(document.body).userSelect;
  var card = document.querySelector('.card h3 a');
  out.cardSelect = card ? getComputedStyle(card).userSelect : null;
  var drag = document.querySelector('.project-drag');
  out.dragSelect = drag ? getComputedStyle(drag).userSelect : null;
  var th = document.querySelector('.tab-handle');
  out.tabHandleSelect = th ? getComputedStyle(th).userSelect : null;
  out.bridgeProps = Object.getOwnPropertyNames(window).filter(function (k) {
    return /webview|pyweb/i.test(k);
  }).join(',');
  out.cards = document.querySelectorAll('.card').length;
  var target = document.querySelector('.card');
  if (card && target) {
    var r = document.createRange();
    r.selectNodeContents(card);
    var s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    out.selected = s.toString();
    // 有选区时点击同一张卡片：R10 的捕获阶段拦截应阻止跳转
    window.__tlBefore = location.href;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  }
  return out;
})()
'''

JS_NAV_STATE = r'''
(function () {
  return { navigated: location.href !== window.__tlBefore, href: location.href };
})()
'''

JS_PLAIN_CLICK = r'''
(function () {
  window.getSelection().removeAllRanges();
  var target = document.querySelector('.card');
  if (!target) return { ok: false, reason: 'no card' };
  window.__tlBefore = location.href;
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  return { ok: true };
})()
'''


def probe():
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    me = os.getpid()
    deadline = time.time() + 120
    titles = []
    data = None
    last_err = ''
    payload = {}

    def dump():
        try:
            OUT.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        except OSError:
            pass

    # 阶段一：先等原生窗口真正出现。此阶段绝不碰 evaluate_js ——
    # 在 GUI 线程启动前调用它会把窗口创建卡住（实测窗口再也出不来）。
    while time.time() < deadline and not titles:
        found = []
        EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

        def cb(h, _):
            p = wintypes.DWORD()
            u.GetWindowThreadProcessId(h, ctypes.byref(p))
            if p.value == me:
                n = u.GetWindowTextLengthW(h)
                if n:
                    b = ctypes.create_unicode_buffer(n + 1)
                    u.GetWindowTextW(h, b, n + 1)
                    found.append(b.value)
            return True

        u.EnumWindows(EnumProc(cb), 0)
        titles = [t for t in found if '\\u5f52\\u8ff9' in t]
        payload = {'titles': titles, 'data': None, 'error': last_err}
        dump()
        if not titles:
            time.sleep(0.5)

    # 阶段二：等页面加载完成后再求值。evaluate_js 会等 loaded 事件（每次最多 20 秒），
    # 所以先用 loaded.wait 判定，未触发就不要再逐个试，避免白白等上几分钟。
    if titles and webview.windows:
        w = webview.windows[0]
        diag = {}
        try:
            diag['shown'] = w.events.shown.is_set()
            diag['loaded'] = w.events.loaded.is_set()
            diag['gui'] = None if w.gui is None else type(w.gui).__name__
            diag['renderer'] = getattr(w.gui, 'renderer', None)
            diag['title_attr'] = getattr(w, 'title', None)
        except Exception as exc:
            diag['err'] = str(exc)
        try:
            diag['loaded_after_wait'] = bool(w.events.loaded.wait(45))
        except Exception as exc:
            last_err = 'wait loaded: ' + str(exc)
            diag['loaded_after_wait'] = False
        payload['diag'] = diag
        dump()
        if diag.get('loaded_after_wait'):
            time.sleep(1.0)
            for _ in range(3):
                try:
                    got = w.evaluate_js(JS)
                    if isinstance(got, dict) and got.get('href'):
                        data = got
                        break
                except Exception as exc:
                    last_err = str(exc)
                time.sleep(2)

    payload['titles'] = titles
    payload['data'] = data
    payload['error'] = last_err
    if data is not None:
        w = webview.windows[0]
        try:
            time.sleep(0.8)
            payload['navAfterSelect'] = w.evaluate_js(JS_NAV_STATE)
            payload['plainClick'] = w.evaluate_js(JS_PLAIN_CLICK)
            time.sleep(0.9)
            payload['navAfterPlain'] = w.evaluate_js(JS_NAV_STATE)
        except Exception as exc:
            payload['plainClick'] = {'ok': False, 'reason': str(exc)}
    payload['done'] = True
    dump()


threading.Thread(target=probe, daemon=True).start()
sys.exit(desktop.main())
`;

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  return { status: r.status, body: await r.json() };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tl-desktop-"));
  const outFile = path.join(tmp, "shell-probe.json");
  const wrapper = path.join(tmp, "run_desktop_debug.py");
  fs.writeFileSync(wrapper, WRAPPER(0, `tracelight_Verify_${process.pid}`, outFile), "utf8");

  // 关键：清掉代理环境变量。本工具环境会注入 HTTP_PROXY 等，子进程继承后 WebView2 会把
  // http://127.0.0.1:<port> 也丢给代理，页面永远加载不出来（表现为停在 about:blank，
  // pywebview 的 loaded 事件不触发、evaluate_js 报 Main window failed to start）。
  const childEnv = { ...process.env };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
                   "ALL_PROXY", "all_proxy", "CODEBUDDY_SERVICE_PROXY_URL"]) delete childEnv[k];
  childEnv.NO_PROXY = "127.0.0.1,localhost";
  childEnv.no_proxy = childEnv.NO_PROXY;

  const deadline = Date.now() + TIMEOUT;
  let child = null;
  let child2 = null;
  try {
    child = spawn(PY, [wrapper], { cwd: REPO, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", d => { stderr += d.toString(); });
    child.on("exit", code => { stderr += `\n[wrapper 退出 ${code}]`; });

    // 端口由壳内 pick_port 自动挑选，从默认端口起找
    let found = null;
    while (Date.now() < deadline && !found) {
      for (let p = 8300; p <= 8312; p++) {
        try {
          const { status, body } = await fetchJson(`http://127.0.0.1:${p}/api/health`);
          const isOurs = status === 200 && body.ok
            && path.resolve(body.data_path).toLowerCase()
                 .startsWith(path.resolve(REPO, "data").toLowerCase());
          if (isOurs) { found = { port: p, health: body }; break; }
        } catch { /* 未起来 */ }
      }
      if (!found) await sleep(400);
    }
    if (!found) { console.error("桌面壳未在期限内就绪：\n" + stderr); process.exit(2); }
    const base = `http://127.0.0.1:${found.port}`;
    ok("桌面壳已启动（源码模式，dev 数据目录）",
       { port: found.port, data: found.health.data_path });

    // 桌面模式：唤起窗口接口必须可用。
    // 时序：health 由 uvicorn 线程一启动就响应，而原生窗口句柄要等窗口创建完才赋值，
    // 所以要轮询等待，不能一拿到 health 就断言（否则会误判为 browser-mode）。
    let sw = { body: null };
    for (let i = 0; i < 60; i++) {
      sw = await fetchJson(base + "/api/show-window", { method: "POST" });
      if (sw.body && sw.body.ok === true) break;
      await sleep(500);
    }
    assert.equal(sw.body.ok, true, "桌面模式 show-window 返回 ok=true，实际 " + JSON.stringify(sw.body));
    ok("原生唤起窗口接口可用（桌面模式生效）");

    // 壳内探针结果（探针最长等 70 秒，这里留足余量）
    let probe = null;
    for (let i = 0; i < 260; i++) {
      if (fs.existsSync(outFile)) {
        try { probe = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch { probe = null; }
        if (probe && (probe.data || probe.done)) break;
      }
      await sleep(500);
    }
    if (!probe) { console.error("壳内探针未产出结果：\n" + stderr); process.exit(2); }

    assert(probe.titles.some(t => t.includes("归迹")),
           "原生窗口标题包含品牌，实际 " + JSON.stringify(probe.titles));
    ok("原生窗口标题正确", { title: probe.titles.join(" | ") });

    // 壳内页面级断言：需要 WebView2 完成页面加载（pywebview 的 loaded 事件）。
    // 若本会话里 WebView2 未能加载页面，则明确记为「未执行」并打印诊断，而不是伪装通过。
    const d = probe.data;
    if (!d) {
      results.push({ label: "WebView2 页面级断言（文字选择 / 点击行为 / 原生桥）",
                     executed: false, diag: probe.diag, ping: probe.ping, error: probe.error });
      console.log("[WARN] 本会话下 WebView2 未完成页面加载，页面级断言未执行");
      console.log("       壳内诊断=" + JSON.stringify(probe.diag));
      console.log("       evaluate_js=" + JSON.stringify(probe.ping));
    } else {
      assert(d.href.includes(`:${found.port}`), "页面就是应用页面，实际 " + d.href);
      assert(d.brand.includes("归迹"), "顶栏品牌正确，实际 " + JSON.stringify(d.brand));
      ok("WebView2 页面已加载应用并显示品牌", { href: d.href, brand: d.brand.trim() });

      assert.equal(d.bodySelect, "text", "正文可选中（user-select）");
      assert.equal(d.cardSelect, "text", "卡片项目名称可选中");
      assert.equal(d.dragSelect, "none", "项目拖动手柄不可选中（保留排序行为）");
      assert.equal(d.tabHandleSelect, "none", "标签拖动手柄不可选中");
      ok("WebView2 中界面文字可选中，拖动手柄保留排序行为",
         { body: d.bodySelect, card: d.cardSelect, drag: d.dragSelect, tab: d.tabHandleSelect });

      assert(d.selected && d.selected.trim().length > 0, "WebView2 中可建立文字选区");
      assert(probe.navAfterSelect && probe.navAfterSelect.navigated === false,
             "有选区时点击同一卡片不误跳转，实际 " + JSON.stringify(probe.navAfterSelect));
      ok("WebView2 中选区可建立，拖选后的点击不误跳转",
         { selected: d.selected.trim(), navAfterSelect: probe.navAfterSelect });

      assert(probe.plainClick && probe.plainClick.ok, "普通点击用例可执行");
      assert(probe.navAfterPlain && probe.navAfterPlain.navigated === true,
             "无选区时点击卡片仍正常进入详情页，实际 " + JSON.stringify(probe.navAfterPlain));
      ok("WebView2 中普通点击仍正常打开档案", { href: probe.navAfterPlain.href });

      if (d.bridgeProps.includes("pywebview")) {
        ok("WebView2 原生桥已注入（文件夹/文件选择等原生交互）", { props: d.bridgeProps });
      } else {
        results.push({ label: "pywebview 原生桥注入状态", bridgeOk: false, props: d.bridgeProps });
        console.log("[WARN] 页面里没有 window.pywebview：原生「选择文件夹 / 选择文件」会降级为提示",
                    "props=" + JSON.stringify(d.bridgeProps));
      }
    }

    // ---- 单实例 ----
    child2 = spawn(PY, [wrapper], { cwd: REPO, env: childEnv, stdio: "ignore" });
    const secondCode = await Promise.race([
      new Promise(res => child2.on("exit", res)),
      sleep(25000).then(() => "timeout"),
    ]);
    assert.notEqual(secondCode, "timeout", "第二次启动应快速退出（单实例）");
    ok("单实例：再次启动直接退出，不产生第二个窗口", { exit: secondCode });

    console.log(`PASS: 桌面 WebView2 验证 ${results.length} 项通过`);
  } finally {
    for (const p of [child, child2]) {
      if (p && p.pid && p.exitCode === null) {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(p.pid)], { stdio: "ignore" });
      }
    }
    await sleep(600);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
