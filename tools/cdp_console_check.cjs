#!/usr/bin/env node
// T8.2 控制台错误采集（可复用回归脚本）：
// 用 headless Chrome + CDP 真实鼠标事件跑关键交互（流程图候选切换、编辑弹窗越界拖选、
// 启动项编辑取消），全程采集 console.error/warning、未捕获异常与 Log 域错误，最后汇总。
// 用法：node tools/cdp_console_check.cjs --base http://127.0.0.1:8311 [--port 9333] [--pid 14]
// 退出码：0 = 无错误级输出；1 = 有错误；2 = 环境问题。

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const BASE = arg("base", "http://127.0.0.1:8311").replace(/\/$/, "");
const CHROME = arg("chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe");
const PORT = Number(arg("port", "9333"));
const PID = Number(arg("pid", "14"));

const issues = [];   // { kind, text, step }
let step = "启动";
function record(kind, text) {
  issues.push({ kind, text: String(text).slice(0, 300), step });
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tl-cdp-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + profile, "--window-size=1440,900",
    "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    // 等调试端口就绪
    let version = null;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        version = await r.json();
        break;
      } catch { await sleep(250); }
    }
    if (!version) { console.error("CDP 调试端口未就绪"); return 2; }

    // 新建标签页
    let target = null;
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
      if (r.ok) { target = await r.json(); break; }
      await sleep(300);
    }
    if (!target) { console.error("无法创建 CDP 标签页"); return 2; }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Runtime.consoleAPICalled" &&
          ["error", "warning"].includes(m.params.type)) {
        const text = m.params.args.map(a => a.value ?? a.description ?? a.type).join(" ");
        record("console." + m.params.type, text);
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        record("exception", (d.exception && (d.exception.description || d.exception.value)) || d.text);
      } else if (m.method === "Log.entryAdded") {
        const e = m.params.entry;
        if (["error", "warning"].includes(e.level)) record("log." + e.level, e.text);
      }
    };
    const send = (method, params = {}) => new Promise((res) => {
      const id = ++msgId;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evalJS = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
      if (r.result && r.result.exceptionDetails) {
        record("eval-exception", r.result.exceptionDetails.text);
        return null;
      }
      return r.result && r.result.result ? r.result.result.value : null;
    };
    // finder 返回候选元素数组；滚动到首个可见元素并取中心坐标（面板多在首屏之下）
    const center = async (finder) => {
      const p = await evalJS(`(() => {
        const cands = ${finder};
        for (const el of cands) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            if (r.y < 0 || r.y > window.innerHeight - 4)
              el.scrollIntoView({ block: "center", behavior: "instant" });
            const r2 = el.getBoundingClientRect();
            return { x: Math.round(r2.x + r2.width / 2), y: Math.round(r2.y + r2.height / 2) };
          }
        }
        return null;
      })()`);
      return p;
    };
    const clickAt = async (x, y) => {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, pointerType: "mouse" });
      await sleep(50);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, pointerType: "mouse" });
    };
    const clickEl = async (finder, label) => {
      const p = await center(finder);
      if (!p) { record("script", `未找到元素：${label}`); return false; }
      await sleep(300);
      await clickAt(p.x, p.y);
      await sleep(500);
      return true;
    };

    await send("Runtime.enable");
    await send("Log.enable");
    await send("Page.enable");

    // ① 首页加载
    step = "首页加载";
    await send("Page.navigate", { url: BASE + "/" });
    await sleep(1600);
    const cards = await evalJS(`document.querySelectorAll('h3').length`);
    console.log(`[步骤] 首页加载：卡片数 = ${cards}`);

    // ② 详情页加载
    step = "详情页加载";
    await send("Page.navigate", { url: `${BASE}/project/${PID}` });
    await sleep(1800);
    const flowBtn = await evalJS(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '更换流程图')`);
    console.log(`[步骤] 详情页加载：更换流程图按钮存在 = ${flowBtn}`);

    // ③ 更换流程图 → 选择候选 → 恢复自动识别
    step = "流程图候选切换";
    await clickEl(`[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '更换流程图')`, "更换流程图");
    const picked = await clickEl(
      `[...document.querySelectorAll('button')].filter(b => b.textContent.includes('workflow.svg'))`, "workflow.svg 候选");
    await sleep(400);
    const cur1 = await evalJS(`(()=>{ const c=[...document.querySelectorAll('*')].find(e=>!e.children.length&&/自动识别 · /.test(e.textContent)&&e.textContent.length<60); return c?c.textContent.trim():null;})()`);
    console.log(`[步骤] 选择候选后当前图：${cur1}`);
    await clickEl(`[...document.querySelectorAll('button')].filter(b => b.textContent.includes('恢复自动识别'))`, "恢复自动识别");
    const cur2 = await evalJS(`(()=>{ const c=[...document.querySelectorAll('*')].find(e=>!e.children.length&&/自动识别 · /.test(e.textContent)&&e.textContent.length<60); return c?c.textContent.trim():null;})()`);
    console.log(`[步骤] 恢复自动后当前图：${cur2}`);

    // ④ 编辑档案弹窗：输入框内按下 → 拖出弹窗 → 松手（T7 场景）
    step = "编辑弹窗越界拖选";
    await clickEl(`[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '编辑档案')`, "编辑档案");
    await sleep(400);
    const g = await evalJS(`(() => {
      const m = [...document.querySelectorAll('.modal-mask')].find(x => getComputedStyle(x).display !== 'none');
      if (!m) return null;
      const box = m.firstElementChild.getBoundingClientRect();
      const input = m.querySelector('input');
      const ir = input.getBoundingClientRect();
      return { inX: Math.round(ir.x + 60), inY: Math.round(ir.y + ir.height / 2),
               outX: Math.round(box.x - 70), midY: Math.round(box.y + box.height / 2) };
    })()`);
    if (!g) { record("script", "编辑档案弹窗未打开"); }
    else {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: g.inX, y: g.inY, button: "left", clickCount: 1, pointerType: "mouse" });
      for (let i = 1; i <= 6; i++) {
        await sleep(40);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved",
          x: Math.round(g.inX + (g.outX - g.inX) * i / 6), y: g.inY, button: "left", pointerType: "mouse" });
      }
      await sleep(60);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: g.outX, y: g.inY, button: "left", clickCount: 1, pointerType: "mouse" });
      await sleep(400);
      const still = await evalJS(`[...document.querySelectorAll('.modal-mask')].some(x => getComputedStyle(x).display !== 'none')`);
      console.log(`[步骤] 越界拖选后弹窗仍打开 = ${still}`);
      // 正常遮罩点击关闭
      await clickAt(g.outX, g.midY);
      await sleep(400);
    }

    // ⑤ 启动项编辑取消
    step = "启动项编辑取消";
    await clickEl(`[...document.querySelectorAll('button')].filter(b => (b.getAttribute('aria-label') || '').includes('编辑自动检测入口') || b.textContent.trim() === '编辑启动项')`, "编辑启动项");
    await sleep(400);
    await clickEl(`[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '取消')`, "取消");

    // 汇总
    await sleep(600);
    ws.close();
    const errors = issues.filter(i => !i.kind.endsWith("warning") && i.kind !== "script");
    console.log(`\n===== 控制台采集结果：${issues.length} 条记录，其中错误级 ${errors.length} 条 =====`);
    for (const i of issues) console.log(`  [${i.step}] ${i.kind}: ${i.text}`);
    const scriptIssues = issues.filter(i => i.kind === "script");
    if (scriptIssues.length) { console.log("脚本步骤异常，见上。"); return 1; }
    return errors.length ? 1 : 0;
  } finally {
    chrome.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().then(code => process.exit(code)).catch(e => { console.error("运行失败：", e); process.exit(2); });
