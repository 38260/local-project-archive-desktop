// 使用已安装的 Playwright；仅接受本轮隔离测试实例，保护正式档案和系统剪贴板。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const root = fs.realpathSync(state.root);
assert(path.basename(root).startsWith("tl-fixes-"));
assert(!path.relative(os.tmpdir(), root).startsWith(".."));

(async () => {
  const health = await (await fetch(state.base + "/api/health")).json();
  assert.equal(path.resolve(health.data_path).toLowerCase(),
    path.join(root, "data/projects.db").toLowerCase());
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
      e.preventDefault(); // 验证复制内容，不覆盖用户系统剪贴板。
    }, true);
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const results = [];
  async function selectText(locator, label) {
    await locator.evaluate(el => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await page.evaluate(() => window.getSelection().removeAllRanges());
    const box = await locator.boundingBox();
    assert(box && box.width > 4, label);
    const url = page.url();
    const writes = await page.evaluate(() => window.testClipboardWrites.length);
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(box.width - 2, 150), box.y + box.height / 2, { steps: 16 });
    const intended = await page.evaluate(() => window.getSelection().toString());
    assert(intended.length > 0, label + " 可拖选");
    await page.mouse.up();
    await page.waitForTimeout(350);
    assert.equal(page.url(), url, label + " 不触发跳转");
    assert.equal(await page.evaluate(() => window.getSelection().toString()), intended);
    assert.equal(await page.evaluate(() => window.testClipboardWrites.length), writes);
    await page.keyboard.press("Control+c");
    assert.equal(await page.evaluate(() => window.testCopiedSelection), intended);
    results.push({ label, selected: intended, copied: true });
  }
  try {
    const alpha = state.projects.find(p => p.name === "select-project-alpha");
    const beta = state.projects.find(p => p.name === "select-project-beta");
    await page.goto(state.base);
    await page.locator(".card h3").first().waitFor();
    await selectText(page.locator(`.card[data-project-id="${alpha.id}"] h3 a`), "首页项目名称");
    await selectText(page.locator(`.card[data-project-id="${alpha.id}"] .path`).first(), "首页项目路径");
    await page.goto(state.base + "/project/" + beta.id);
    await page.locator(".launch-row").first().waitFor();
    await selectText(page.locator(".proj-path-text"), "详情路径");
    await selectText(page.locator(".launch-cmd").first(), "启动命令");
    await selectText(page.locator(".tree .t-name").filter({ hasText: "README.md" }).first(), "目录树文件名");
    await selectText(page.locator("#sec-readme .md-body p").first(), "README 正文");
    await selectText(page.locator(".tab-label").filter({ hasText: alpha.name }).first(), "顶部标签名称");
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.getByRole("button", { name: "编辑档案", exact: true }).click();
    await page.locator("#edit-name").waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#edit-name").isVisible(), false);
    const tabs = page.locator(".tab[role=tab]");
    const before = await tabs.locator(".tab-label").allTextContents();
    const first = tabs.filter({ hasText: alpha.name });
    const target = tabs.filter({ hasText: beta.name });
    await first.locator(".tab-handle").dragTo(target);
    await page.waitForTimeout(150);
    const after = await tabs.locator(".tab-label").allTextContents();
    assert.notDeepEqual(after, before, "标签图标拖动仍可排序");
    assert.equal(errors.length, 0, errors.join("\n"));
    fs.writeFileSync(path.join(root, "browser-results.json"), JSON.stringify({ results, tabs: { before, after }, errors }, null, 2));
    console.log(`PASS: ${results.length} 类文字拖选与 Ctrl+C、无误跳转/自动复制、正常按钮和标签拖动`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
