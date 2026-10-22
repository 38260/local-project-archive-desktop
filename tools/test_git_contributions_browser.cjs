// 沿用项目 Playwright 测试台，真实操作设置、作者切换与刷新。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { chromium } = require("playwright");
const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const root = fs.realpathSync(state.root);
assert(path.basename(root).startsWith("tl-fixes-"));
assert(!path.relative(os.tmpdir(), root).startsWith(".."));
const output = process.env.TL_EVIDENCE || path.join(root, "evidence");
fs.mkdirSync(output, { recursive: true });

(async () => {
  const health = await (await fetch(state.base + "/api/health")).json();
  assert.equal(path.resolve(health.data_path).toLowerCase(), path.join(root, "data/projects.db").toLowerCase());
  const { projects } = await (await fetch(state.base + "/api/projects")).json();
  const source = projects.find(p => p.name === "source");
  assert(source, "先运行贡献 API 回归生成仓库");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const results = [];
  const ok = label => { results.push(label); console.log("[PASS]", label); };
  async function openRecords() {
    await page.locator(".tab-nav .tab-btn").filter({ hasText: "开发记录" }).click();
    await page.locator("#sec-commits").waitFor({ state: "visible" });
  }
  const waitText = (locator, text) => page.waitForFunction(({ selector, text }) =>
    document.querySelector(selector)?.textContent.includes(text), { selector: locator, text });
  async function saveEmails(value) {
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    await dialog.getByLabel("我的 Git 邮箱", { exact: true }).fill(value);
    const saved = page.waitForResponse(r => r.url().endsWith("/api/settings") && r.request().method() === "PUT" && r.status() === 200);
    await dialog.getByRole("button", { name: "保存 Git 邮箱", exact: true }).click();
    await saved;
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
  }
  try {
    await page.goto(state.base);
    await page.getByRole("button", { name: "设置 Git 邮箱", exact: true }).click();
    const invalidInput = page.getByLabel("我的 Git 邮箱", { exact: true });
    await invalidInput.fill("not-an-email");
    const rejected = page.waitForResponse(r => r.url().endsWith("/api/settings") && r.status() === 400);
    await page.getByRole("button", { name: "保存 Git 邮箱", exact: true }).click();
    await rejected;
    assert.equal(await invalidInput.inputValue(), "not-an-email");
    await saveEmails("ME+WORK@example.com\nold@example.com");
    await waitText(".week-sub", "2 次提交");
    ok("首页设置多个邮箱后本周拾光重算为 2 条，fork 副本不重复计数");

    // 柱悬停/键盘聚焦提示、查看近 7 天明细
    const weekBar = page.locator(".week-col.has-commits").first();
    await weekBar.hover();
    await page.locator(".week-tip").waitFor();
    assert.match(await page.locator(".week-tip").innerText(), /次提交/);
    await weekBar.focus();
    await page.locator(".week-tip").waitFor();
    await page.getByRole("button", { name: "查看明细", exact: false }).click();
    const weekDialog = page.getByRole("dialog", { name: "近 7 天提交明细" });
    await weekDialog.waitFor();
    assert((await weekDialog.locator(".week-detail-day").count()) > 0);
    await page.keyboard.press("Escape");
    await weekDialog.waitFor({ state: "hidden" });
    ok("本周拾光悬停/聚焦提示、查看明细与本地日期明细可用");

    // 折叠状态刷新后保持
    await page.locator(".week-toggle").click();
    assert.equal(await page.locator("#week-body").isVisible(), false);
    await page.reload();
    await waitText(".week-sub", "2 次提交");
    assert.equal(await page.locator("#week-body").isVisible(), false);
    await page.locator(".week-toggle").click();
    assert.equal(await page.locator("#week-body").isVisible(), true);
    ok("本周拾光折叠状态刷新后保持");

    await page.locator(".week-col.has-commits").first().click();
    await waitText(".day-group", "old@example.com");
    assert.equal(await page.locator(".day-timeline li").count(), 2);
    assert.equal(await page.locator('.day-timeline a[href^="/project/"]').count(), 2);
    const associated = page.locator('.day-timeline a[href^="/project/"]').first();
    const associatedPath = await associated.getAttribute("href");
    await associated.click();
    await page.waitForURL(state.base + associatedPath);
    await waitText("#sec-commits .count", "2 次");
    ok("当天弹窗只展示两条唯一提交并提供另一副本入口");

    await page.goto(`${state.base}/project/${source.id}`);
    await openRecords();
    await waitText("#sec-commits .count", "2 次");
    assert.equal(await page.locator("#sec-commits .ci-ring-center b").innerText(), "2");
    await waitText("#sec-commits .month-chart .heat-sub", "2 次提交");
    const panel = page.locator("#sec-commits");
    await panel.getByRole("button", { name: "全部作者", exact: true }).click();
    await waitText("#sec-commits .count", "5 次");
    await waitText("#sec-commits .ci-ring-center", "5");
    await waitText("#sec-commits .month-chart .heat-sub", "5 次提交");
    await page.reload();
    await openRecords();
    await waitText("#sec-commits .count", "5 次");
    assert.equal(await panel.getByRole("button", { name: "全部作者", exact: true }).getAttribute("aria-pressed"), "true");
    ok("详情切换三个区域同步为全部 5 条，刷新保持所选范围");
    await panel.getByRole("button", { name: "仅本人", exact: true }).click();
    await waitText("#sec-commits .count", "2 次");
    await page.waitForFunction(() => !document.querySelector(".toast"));
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await saveEmails("absent@example.com");
    await waitText("#sec-commits", "未找到匹配我的 Git 邮箱的提交");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await saveEmails("");
    await panel.getByRole("button", { name: "设置 Git 邮箱", exact: true }).waitFor();
    await panel.getByRole("button", { name: "全部作者", exact: true }).click();
    await waitText("#sec-commits .count", "5 次");
    ok("无匹配与未设置分别提示，清空身份后仍可查看完整历史");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await saveEmails("me+work@example.com\nold@example.com");
    await panel.getByRole("button", { name: "仅本人", exact: true }).click();
    await waitText("#sec-commits .count", "2 次");

    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => window.setThemePref(theme), theme);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await panel.scrollIntoViewIfNeeded();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert(overflow <= 1, `详情 ${theme}/${width} 横向溢出 ${overflow}`);
        await panel.screenshot({ path: path.join(output, `git-contributions-${theme}-${width}.png`) });
      }
    }
    ok("详情亮暗主题、1440/390 宽度无横向溢出并留存截图");
    await page.goto(state.base);
    await waitText(".week-sub", "2 次提交");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const emailInput = page.getByLabel("我的 Git 邮箱", { exact: true });
    assert.equal(await emailInput.inputValue(), "me+work@example.com\nold@example.com");
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    await dialog.screenshot({ path: path.join(output, "git-email-settings-390.png") });
    ok("跨页面设置持久化，窄屏设置入口可编辑和保存");
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, "git-contributions-browser.json"), JSON.stringify({ results, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
