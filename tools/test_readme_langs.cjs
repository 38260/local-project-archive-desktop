// README 多语言版本切换：只用本轮隔离测试实例，绝不影响正式档案。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const root = fs.realpathSync(state.root);
assert(path.basename(root).startsWith("tl-fixes-"));
assert(!path.relative(os.tmpdir(), root).startsWith(".."));

const panel = page => page.locator("#sec-readme");
const chips = page => panel(page).locator(".readme-lang");

(async () => {
  const health = await (await fetch(state.base + "/api/health")).json();
  assert.equal(path.resolve(health.data_path).toLowerCase(),
    path.join(root, "data/projects.db").toLowerCase());
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const results = [];
  const record = (label, value) => { results.push({ label, value }); console.log(`  ✓ ${label}: ${value}`); };

  async function openReadme(id) {
    await page.goto(state.base + "/project/" + id);
    await page.locator(".tab-nav .tab-btn").filter({ hasText: "项目资料" }).click();
    await page.locator("#sec-readme").waitFor({ state: "visible" });
    await chips(page).first().waitFor({ timeout: 10000 }).catch(() => {});
    await panel(page).locator(".md-body").first().waitFor();
    await panel(page).evaluate(el => el.scrollIntoView({ block: "start", behavior: "instant" }));
  }
  const bodyText = () => panel(page).locator(".md-body").innerText();
  const activeChip = () => panel(page).locator(".readme-lang.on");
  const chipLabels = () => chips(page).allTextContents();

  try {
    const alpha = state.projects.find(p => p.name === "select-project-alpha");
    const beta = state.projects.find(p => p.name === "select-project-beta");

    // ---- 多语言项目：切换条 + 标签 ----
    await openReadme(alpha.id);
    assert.equal(await chips(page).count(), 3, "根目录 3 份 README 应有 3 个切换按钮");
    const labels = await chipLabels();
    assert.deepEqual(labels, ["中文", "繁體中文", "English"], `按钮标签按语言命名：${labels}`);
    assert.equal(await panel(page).locator(".readme-lang.on").textContent(), "中文");
    assert.equal(await panel(page).locator(".readme-langs").count(), 1);
    record("切换条按钮", labels.join(" | "));
    // 多版本时不再单列文件名（按钮 title 已给出），单列会与切换条重复
    assert.equal(await panel(page).locator("h2 .section-note").count(), 0, "多版本时隐藏重复的文件名注释");
    assert.match(await bodyText(), /文字拖选验证/, "默认渲染主版本（中文）");

    // ---- 点按钮切换 ----
    await page.getByRole("button", { name: "English", exact: true }).click();
    await page.waitForTimeout(400);
    const english = await bodyText();
    assert.match(english, /language switching/, "切到英文版后正文换成英文");
    assert.doesNotMatch(english, /文字拖选验证/, "中文正文不再残留");
    assert.equal(await panel(page).locator(".readme-lang.on").textContent(), "English");
    assert.equal((await chipLabels()).length, 3, "切换后按钮数量不变，可切回去");
    record("按钮切换", "English → README_EN.md");

    // ---- 刷新后保持所选版本 ----
    await page.reload();
    await openReadme(alpha.id);
    assert.match(await bodyText(), /language switching/, "刷新后仍是英文版（按项目记忆）");
    assert.equal(await panel(page).locator(".readme-lang.on").textContent(), "English");
    record("版本记忆", await page.evaluate(
      key => localStorage.getItem(key), "tl-readme-lang-" + alpha.id));

    // ---- 正文里的语言切换链接：面板内切换，不盖文档浮层 ----
    assert.equal(await page.locator(".doc-modal-mask").count(), 0);
    await page.locator("#sec-readme .md-body a[href='README.md']").click();
    await page.waitForTimeout(400);
    assert.match(await bodyText(), /文字拖选验证/, "点正文语言链接直接换面板版本");
    assert.equal(await page.locator(".doc-modal-mask").count(), 0, "语言链接不再打开文档浮层");
    assert.equal(await panel(page).locator(".readme-lang.on").textContent(), "中文");
    record("正文语言链接", "README_EN.md → README.md（应用内切换）");

    // ---- 键盘可操作（不依赖悬停/鼠标） ----
    await activeChip(page).focus();
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement.className);
    assert.match(focused, /readme-lang/, "按钮可用 Tab 聚焦");
    const before = await panel(page).locator(".readme-lang.on").textContent();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    assert.notEqual(await panel(page).locator(".readme-lang.on").textContent(), before, "回车即可切换版本");
    record("键盘操作", `${before} → ${await panel(page).locator(".readme-lang.on").textContent()}`);

    await page.locator("#sec-readme h2").screenshot({ path: path.join(root, "readme-langs-header.png") });

    // ---- 只有一份 README 的项目：不出现切换条 ----
    await openReadme(beta.id);
    assert.equal(await chips(page).count(), 0, "单份 README 不显示切换条");
    assert.equal(await panel(page).locator("h2 .section-note").textContent(), "README.md",
      "单份时仍显示文件名");
    assert.match(await bodyText(), /第二段正文/);
    record("单版本项目", "无切换条，仅显示 README.md");

    assert.equal(errors.length, 0, errors.join("\n"));
    fs.writeFileSync(path.join(root, "readme-langs-results.json"),
      JSON.stringify({ results, errors }, null, 2));
    console.log(`PASS: ${results.length} 项 README 多语言切换验证通过`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
