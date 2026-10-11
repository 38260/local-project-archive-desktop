// R11 浏览器整体复验：只接受本轮隔离实例的 state.json，保护正式档案与系统剪贴板。
// 覆盖：SVG 直接打开的脚本隔离、流程图上传/导出/恢复自动、启动项默认入口与保存失败回退、
//       弹窗越界拖选、亮暗主题 × 窄屏无横向溢出、界面文字拖选复制。
// 用法：node tools/test_browser_r11.cjs <state.json>
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const root = fs.realpathSync(state.root);
assert(path.basename(root).startsWith("tl-fixes-"), "只接受本轮隔离实例目录");
assert(!path.relative(os.tmpdir(), root).startsWith(".."), "隔离实例必须在系统临时目录内");

const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
  "0000000d49444154789c63f8ffffff7f0009fb03fd2a86e38a0000000049454e44ae426082", "hex");
// 带内联脚本的 SVG：直接以文档方式打开时脚本必须被 CSP sandbox 拦下
const SVG_EVIL = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">
<script>window.__svgPwned=true;document.title="PWNED";</script>
<rect width="80" height="40" fill="#cde"/></svg>`;
const PNG_UPLOAD_NAME = "r11-uploaded.png";

const results = [];
function ok(label, extra) {
  results.push(extra === undefined ? { label } : { label, extra });
  console.log("[PASS]", label);
}

async function uploadFlowchart(pid, name, buf, type) {
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type }), name);
  const r = await fetch(`${state.base}/api/projects/${pid}/flowchart/upload`,
                        { method: "POST", body: fd });
  return { status: r.status, body: await r.json() };
}

(async () => {
  const health = await (await fetch(state.base + "/api/health")).json();
  assert.equal(path.resolve(health.data_path).toLowerCase(),
    path.join(root, "data/projects.db").toLowerCase());

  const alpha = state.projects.find(p => p.name === "select-project-alpha");
  const beta = state.projects.find(p => p.name === "select-project-beta");
  assert(alpha && beta, "样例档案齐备");

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    window.testClipboardWrites = [];
    if (navigator.clipboard) {
      Object.defineProperty(navigator.clipboard, "writeText", {
        value: async text => { window.testClipboardWrites.push(text); }, configurable: true,
      });
    }
    document.addEventListener("copy", e => {
      window.testCopiedSelection = window.getSelection().toString();
      e.preventDefault();
    }, true);
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

  try {
    // ---------- A. SVG 直接打开：脚本被阻止 ----------
    const upSvg = await uploadFlowchart(beta.id, "r11-evil.svg", Buffer.from(SVG_EVIL), "image/svg+xml");
    assert.equal(upSvg.status, 201, "带脚本的 SVG 允许上传（按图片处理）");
    const svgUrl = state.base + upSvg.body.saved.url;
    const resp = await page.goto(svgUrl);
    const csp = resp.headers()["content-security-policy"] || "";
    assert(csp.includes("sandbox"), "SVG 文档响应带 CSP sandbox");
    assert.equal(await page.evaluate(() => window.__svgPwned), undefined, "SVG 内联脚本未执行");
    assert.notEqual(await page.title(), "PWNED", "SVG 内联脚本未改写文档");
    ok("SVG 直接打开时脚本被阻止", { csp });

    // ---------- B. 流程图上传 / 导出 / 恢复自动 ----------
    await page.goto(state.base + "/project/" + beta.id);
    await page.locator("#sec-flowchart").waitFor();
    assert.equal(await page.locator(".flow-meta").innerText().then(t => t.includes("手动上传")), true,
                 "上传的 SVG 已被启用为当前流程图");
    await page.getByRole("button", { name: /更换流程图|选择流程图/ }).click();
    await page.locator(".flow-picker").waitFor();
    await page.locator(".flow-upload-row input[type=file]")
      .setInputFiles({ name: PNG_UPLOAD_NAME, mimeType: "image/png", buffer: PNG_1PX });
    // 上传后立即启用：面板切到「手动上传 · <存盘名>.png」
    await page.waitForFunction(() => {
      const el = document.querySelector(".flow-meta");
      return el && el.textContent.includes("手动上传") && el.textContent.includes(".png");
    }, null, { timeout: 8000 });
    const customName = (await page.locator(".flow-meta").innerText())
      .split("·")[1].trim().split("（")[0];
    assert(customName.endsWith(".png"), "上传的 PNG 已启用，实际 " + customName);
    assert.equal(await page.locator(".flow-picker:has-text('本机上传的历史图')").count(), 1,
                 "上传历史区出现");
    assert(await page.locator(".flow-cand-name", { hasText: customName }).count() >= 1,
           "上传历史列出刚上传的图片");
    ok("流程图上传后立即启用并记录历史", { name: customName });

    const expHtml = await fetch(`${state.base}/api/projects/${beta.id}/export-html`);
    assert.equal(expHtml.status, 200, "单项目 HTML 导出返回 200");
    const htmlText = await expHtml.text();
    assert(htmlText.includes("data:image/png;base64,"), "导出 HTML 内嵌当前流程图");
    assert(htmlText.length > 2000, "导出 HTML 非空壳");
    ok("单项目 HTML 导出内嵌流程图（离线可看）", { bytes: htmlText.length });

    await page.getByRole("button", { name: "恢复自动识别" }).click();
    await page.locator('.flow-meta:has-text("自动识别")').waitFor({ timeout: 8000 });
    assert(await page.locator(".flow-meta").innerText().then(t => t.includes("workflow.svg")),
           "恢复自动识别回落项目内候选 docs/workflow.svg");
    assert(await page.locator(".flow-picker:has-text('本机上传的历史图')").count() === 1,
           "恢复自动后上传历史仍保留");
    ok("恢复自动识别回落项目内候选，上传历史保留");

    // ---------- C. 启动项默认入口与保存失败回退 ----------
    const rows = page.locator(".launch-row");
    const rowCount = await rows.count();
    assert(rowCount >= 2, `需要至少 2 个启动入口，实际 ${rowCount}`);
    assert.equal(await page.locator(".launch-row .lb-primary").count(), 1,
                 "默认恰好一个「顶部启动」标记");
    const firstIsPrimary = await rows.first().locator(".lb-primary").count();
    assert.equal(firstIsPrimary, 1, "默认落在顺序第一项");
    const launchBtnTitle = await page.locator(".launch-split .split-main").getAttribute("title");
    assert(launchBtnTitle.startsWith("启动："), "顶部启动按钮绑定默认入口命令");
    ok("顶部启动按钮与默认入口一致（未显式设置时取顺序第一项）");

    // 切换默认项：下拉里选第二项
    const secondName = await rows.nth(1).locator(".launch-name").innerText();
    await page.locator(".launch-split .split-caret").click();
    await page.locator(".launch-menu").waitFor();
    await page.locator(".launch-menu .lm-name", { hasText: secondName }).first().click();
    await page.waitForFunction(name =>
      [...document.querySelectorAll(".launch-row")].findIndex(r =>
        r.querySelector(".lb-primary")) ===
      [...document.querySelectorAll(".launch-row")].findIndex(r =>
        r.querySelector(".launch-name").textContent.trim() === name), secondName);
    assert((await page.locator(".launch-split .split-main").getAttribute("title"))
             .includes(await rows.nth(1).locator(".launch-cmd").innerText()),
           "切换默认项后顶部按钮命令同步");
    ok("下拉选择默认入口生效（不改动列表顺序）");

    // 保存失败回退：拦截 launch-prefs 让它 500
    const orderBefore = await rows.locator(".launch-name").allTextContents();
    const autoRow = page.locator(".launch-row", { has: page.locator(".lb-tag", { hasText: "自动检测" }) }).first();
    assert(await autoRow.count() === 1, "存在自动检测入口用于移除测试");
    await page.route("**/launch-prefs", route =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"detail":"模拟失败"}' }));
    await autoRow.locator('button[aria-label="移除自动检测入口"]').click();
    await page.locator(".toast.error").waitFor({ timeout: 5000 });
    const errToast = await page.locator(".toast.error").last().innerText();
    assert(errToast.includes("已恢复原状态"), "保存失败给出明确提示");
    await page.waitForTimeout(300);
    assert.deepEqual(await rows.locator(".launch-name").allTextContents(), orderBefore,
                     "保存失败后列表回退原状");
    assert.equal(await page.locator(".launch-removed").count(), 0, "失败时未留下隐藏记录");
    await page.unroute("**/launch-prefs");
    ok("启动项偏好保存失败时回退原状态并提示", { toast: errToast });

    // ---------- D. 弹窗越界拖选 ----------
    await page.getByRole("button", { name: "编辑档案", exact: true }).click();
    const nameInput = page.locator("#edit-name");
    await nameInput.waitFor();
    const ib = await nameInput.boundingBox();
    const mb = await page.locator(".modal-mask").boundingBox();
    // 输入框内按下 → 拖到遮罩上松手：不关闭
    await page.mouse.move(ib.x + 4, ib.y + ib.height / 2);
    await page.mouse.down();
    await page.mouse.move(mb.x + 12, mb.y + 12, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert(await nameInput.isVisible(), "输入框拖选到遮罩松手不关闭弹窗");
    // 完整遮罩点击：关闭
    await page.mouse.click(mb.x + 6, mb.y + 6);
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#edit-name").isVisible(), false, "完整点击遮罩正常关闭");
    ok("弹窗越界拖选不误关闭，完整点击遮罩仍可关闭");

    // ---------- E. 文字拖选复制（快速复验） ----------
    await page.locator(".proj-path-text").waitFor();
    const target = page.locator(".proj-path-text");
    await target.evaluate(el => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await page.evaluate(() => window.getSelection().removeAllRanges());
    const tb = await target.boundingBox();
    const urlBefore = page.url();
    await page.mouse.move(tb.x + 2, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + Math.min(tb.width - 2, 120), tb.y + tb.height / 2, { steps: 14 });
    const intended = await page.evaluate(() => window.getSelection().toString());
    await page.mouse.up();
    assert(intended.length > 0, "详情路径可拖选");
    assert.equal(page.url(), urlBefore, "拖选不触发跳转");
    assert.equal(await page.evaluate(() => window.getSelection().toString()), intended, "拖选后选区保持");
    await page.keyboard.press("Control+c");
    assert.equal(await page.evaluate(() => window.testCopiedSelection), intended, "Ctrl+C 复制的是选中文字");
    ok("界面文字拖选复制正常（未跳转、未整段复制）", { selected: intended });

    // ---------- G. 首页项目排序仍可用（拖动手柄，同状态组内） ----------
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(state.base);
    await page.locator(".card").first().waitFor();
    const cards = page.locator(".card");
    const namesBefore = await cards.locator("h3 a").allTextContents();
    const groupBefore = await page.locator(".status-group").evaluateAll(gs =>
      gs.map(g => ({ status: g.dataset.status, count: g.querySelector(".g-count").textContent.trim() })));
    assert(namesBefore.length >= 2, "至少两个项目卡片");
    await cards.nth(0).locator(".project-drag").dragTo(cards.nth(1));
    await page.waitForTimeout(700);
    const settings = await (await fetch(state.base + "/api/settings")).json();
    const savedOrder = settings["ui.project_order"];
    assert(Array.isArray(savedOrder) && savedOrder.length >= 2, "拖动顺序已落库 ui.project_order");
    const namesAfter = await cards.locator("h3 a").allTextContents();
    assert.notDeepEqual(namesAfter, namesBefore, "卡片顺序发生变化");
    const groupAfter = await page.locator(".status-group").evaluateAll(gs =>
      gs.map(g => ({ status: g.dataset.status, count: g.querySelector(".g-count").textContent.trim() })));
    assert.deepEqual(groupAfter, groupBefore, "分组标题与成员数不变");
    await page.reload();
    await page.locator(".card").first().waitFor();
    assert.deepEqual(await cards.locator("h3 a").allTextContents(), namesAfter, "刷新后顺序保持");
    ok("首页项目排序仍可用：组内拖动保存、分组不变、刷新保持", { savedOrder, namesBefore, namesAfter });

    // ---------- F. 亮暗主题 × 窄屏无横向溢出 ----------
    const overflows = [];
    for (const theme of ["light", "dark"]) {
      for (const w of [1440, 1024, 768, 390]) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.evaluate(t => localStorage.setItem("tl-theme", t), theme);
        for (const [label, url] of [["首页", state.base], ["详情页", state.base + "/project/" + beta.id]]) {
          await page.goto(url);
          await page.waitForTimeout(220);
          const info = await page.evaluate(() => ({
            theme: document.documentElement.getAttribute("data-theme"),
            bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
            sw: document.documentElement.scrollWidth, iw: window.innerWidth,
          }));
          assert.equal(info.theme, theme, `${label} ${theme} 主题生效`);
          if (theme === "dark") {
            const m = info.bg.match(/\d+/g).map(Number);
            assert(m[0] + m[1] + m[2] < 90, `${label} 暗色底色为深色`);
          }
          if (info.sw > info.iw + 1) overflows.push({ theme, w, label, sw: info.sw, iw: info.iw });
        }
      }
    }
    assert.deepEqual(overflows, [], "无横向溢出");
    ok("亮/暗主题 × 1440/1024/768/390 无横向溢出");

    // 允许的预期控制台输出（逐条说明，其余一律视为缺陷）：
    //  1) 直接打开沙箱化 SVG 时，浏览器会记一条 "Blocked script execution … sandboxed"
    //     —— 这正是 R1 要的效果（脚本被拦下），不是错误。
    //  2) 本脚本刻意拦截 launch-prefs 返回 500 以验证失败回退，浏览器必然记录该 500。
    const ALLOWED_CONSOLE = [
      { re: /Blocked script execution .*sandboxed/, why: "R1：SVG 文档脚本被隔离，属预期" },
      { re: /status of 500 \(Internal Server Error\)/, why: "本脚本人为拦截 launch-prefs 模拟保存失败" },
    ];
    const unexpected = errors.filter(msg => !ALLOWED_CONSOLE.some(a => a.re.test(msg)));
    const tolerated = errors.filter(msg => ALLOWED_CONSOLE.some(a => a.re.test(msg)));
    assert.deepEqual(unexpected, [], "存在非预期的控制台错误：\n" + unexpected.join("\n"));
    ok("全程无非预期异常与控制台错误", { tolerated });

    fs.writeFileSync(path.join(root, "r11-results.json"),
                     JSON.stringify({ results, tolerated, errors }, null, 2));
    console.log(`PASS: R11 浏览器整体复验 ${results.length} 组全部通过`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
