// 首页改版浏览器回归（isolated_instance 测试台内运行）。
// 覆盖：侧栏渲染、访问时间往返、导航配置保存/重启、响应式无横向溢出、控制台错误。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const root = fs.realpathSync(state.root);
assert(path.basename(root).startsWith("tl-fixes-"));
assert(!path.relative(os.tmpdir(), root).startsWith(".."));
const output = process.env.TL_EVIDENCE || path.join(root, "evidence");
fs.mkdirSync(output, { recursive: true });

async function main() {
  const health = await (await fetch(state.base + "/api/health")).json();
  assert.equal(path.resolve(health.data_path).toLowerCase(),
               path.join(root, "data/projects.db").toLowerCase());
  const listing = await (await fetch(state.base + "/api/projects")).json();
  assert(listing.projects.length >= 2);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce",
  });
  const errors = [];
  const failed = [];
  const results = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", msg => { if (msg.type() === "error") errors.push("console: " + msg.text()); });
  page.on("requestfailed", r => failed.push("failed: " + r.url()));
  page.on("response", r => {
    if (r.status() >= 400 && !r.url().includes("/api/projects/999999")) {
      failed.push(`HTTP ${r.status()}: ${r.url()}`);
    }
  });
  const ok = label => { results.push(label); console.log("[PASS]", label); };
  const waitHome = () => page.waitForFunction(() => {
    const vm = window.__tlHomeVM;
    return vm && vm.loading === false && document.querySelector(".home-sidebar");
  }, null, { timeout: 20000 });

  try {
    await page.goto(state.base);
    await waitHome();
    assert.equal(await page.locator(".card[data-project-id]").count(), listing.projects.length);
    assert.equal(await page.locator('.home-sidebar nav[aria-label="快捷导航"]').count(), 1);
    assert.equal(await page.locator(".home-sidebar .nav-item").count() >= 5, true);
    assert.match(await page.locator(".home-date").innerText(), /年.*月.*日/);
    await page.locator(".open-time").first().waitFor();
    assert.match(await page.locator(".open-time").first().innerText(), /上次打开：/);
    assert.match(await page.locator(".mod-time").first().innerText(), /修改于/);
    await page.screenshot({ path: path.join(output, "home-f3-1440-light.png"), fullPage: true });
    ok("首页侧栏、真实日期、卡片访问/修改时间渲染正常");

    // 卡片软导航 → 详情成功加载记录访问 → 返回首页看到“今天”，刷新仍保留
    const firstId = await page.locator(".card[data-project-id]").first().getAttribute("data-project-id");
    const visit = page.waitForResponse(r =>
      r.url().includes(`/api/projects/${firstId}/visit`) && r.request().method() === "POST"
      && r.status() === 200, { timeout: 20000 });
    await page.locator(`.card[data-project-id="${firstId}"]`).evaluate(el => el.click());
    await page.waitForURL(`**/project/${firstId}`, { timeout: 20000 });
    await page.waitForFunction(() => window.__tlProjectVM && window.__tlProjectVM.p);
    await visit;
    await page.goBack();
    await waitHome();
    await page.waitForFunction(id => {
      const card = document.querySelector(`.card[data-project-id="${id}"]`);
      return card && card.querySelector(".open-time")?.textContent.includes("今天");
    }, firstId, { timeout: 20000 });
    await page.reload();
    await waitHome();
    const afterReload = await page.locator(`.card[data-project-id="${firstId}"] .open-time`).innerText();
    assert.match(afterReload, /上次打开：今天/);
    ok("软导航成功进入详情后记录访问，返回与重启均显示今天");

    // 管理导航：仅标签模板 → 保存 → 状态区消失，刷新后仍保持
    await page.getByRole("button", { name: "模板", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "管理导航" });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "仅标签", exact: true }).click();
    const saved = page.waitForResponse(r =>
      r.url().endsWith("/api/settings") && r.request().method() === "PUT" && r.status() === 200);
    await dialog.getByRole("button", { name: "保存导航配置", exact: true }).click();
    await saved;
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.locator('.home-sidebar section[aria-label="项目状态"]').count(), 0);
    await page.reload();
    await waitHome();
    assert.equal(await page.locator('.home-sidebar section[aria-label="项目状态"]').count(), 0);
    assert.equal(await page.locator('.home-sidebar section[aria-label="常用标签"]').count(), 1);
    ok("导航模板保存生效，刷新后保持");

    // 恢复默认（状态 + 标签），保证后续验收看到完整侧栏
    await page.getByRole("button", { name: "管理导航", exact: true }).click();
    const dialog2 = page.getByRole("dialog", { name: "管理导航" });
    await dialog2.getByRole("button", { name: "状态 + 标签", exact: true }).click();
    const saved2 = page.waitForResponse(r =>
      r.url().endsWith("/api/settings") && r.request().method() === "PUT" && r.status() === 200);
    await dialog2.getByRole("button", { name: "保存导航配置", exact: true }).click();
    await saved2;
    await dialog2.waitFor({ state: "hidden" });

    // 亮/暗与多宽度：无横向溢出，窄屏侧栏收为抽屉
    for (const theme of ["light", "dark"]) {
      await page.evaluate(t => window.setThemePref(t), theme);
      for (const width of [1920, 1440, 1280, 1024, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.waitForTimeout(80);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert(overflow <= 1, `首页 ${theme}/${width} 横向溢出 ${overflow}`);
        if (width <= 1100) {
          assert.equal(await page.locator(".sidebar-toggle").isVisible(), true);
          assert.equal(await page.locator(".home-sidebar").evaluate(el => {
            const r = el.getBoundingClientRect();
            return r.right <= 0;
          }), true, "窄屏侧栏应收起在视口外");
        }
        if (theme === "light" && [1920, 1280, 390].includes(width)) {
          await page.screenshot({ path: path.join(output, `home-f3-${width}.png`), fullPage: true });
        }
        if (theme === "dark" && [1920, 390].includes(width)) {
          await page.screenshot({ path: path.join(output, `home-f3-${width}-dark.png`), fullPage: true });
        }
      }
    }
    ok("亮/暗主题与 1920/1440/1280/1024/768/390 宽度无横向溢出");

    if (errors.length) throw new Error("控制台错误：\n" + errors.join("\n"));
    if (failed.length) throw new Error("失败请求：\n" + failed.join("\n"));
    fs.writeFileSync(path.join(output, "home-f3-browser.json"),
                     JSON.stringify({ results, errors, failed }, null, 2));
    console.log("[PASS] F1/F2/F3 浏览器链路与响应式检查");
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
