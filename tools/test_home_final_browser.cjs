// F6 首页完整验收（先运行 test_home_final_prepare.py 构造隔离样例）。
// 覆盖：真实筛选/搜索/排序/拖动、最近打开、访问记录往返、导航配置、本周拾光交互、
//       多主题多宽度截图、控制台与失败请求。
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

async function json(url) {
  const r = await fetch(url);
  assert.equal(r.status, 200, `${url} -> ${r.status}`);
  return r.json();
}

(async () => {
  const health = await json(state.base + "/api/health");
  assert.equal(path.resolve(health.data_path).toLowerCase(),
               path.join(root, "data", "projects.db").toLowerCase());
  const listing = await json(state.base + "/api/projects");
  const weekly = await json(state.base + "/api/weekly");
  const settings = await json(state.base + "/api/settings");
  const byName = Object.fromEntries(listing.projects.map(p => [p.name, p]));
  assert.equal(listing.projects.length, 10);
  assert.equal(weekly.total, 11);
  assert.equal(weekly.project_count, 5);
  assert.equal(weekly.active_days, 5);
  assert.deepEqual(settings["ui.nav_tags"], ["Python", "Vue", "C#", "Go"]);

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
    if (r.status() >= 400) failed.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  const ok = label => { results.push(label); console.log("[PASS]", label); };
  const waitHome = () => page.waitForFunction(() => {
    const vm = window.__tlHomeVM;
    return vm && vm.loading === false && document.querySelector(".home-sidebar");
  }, null, { timeout: 30000 });
  const waitWeekly = () => page.waitForFunction(() => {
    const vm = window.__tlHomeVM;
    return vm && vm.weeklyLoading === false && vm.weekly;
  }, null, { timeout: 30000 });
  const cardCount = () => page.locator(".card[data-project-id]").count();
  const waitCards = n => page.waitForFunction(
    n => document.querySelectorAll(".card[data-project-id]").length === n, n, { timeout: 10000 });
  const navCount = async (section, label) => {
    const scope = section
      ? page.locator(`.home-sidebar section[aria-label="${section}"]`)
      : page.locator(".home-sidebar nav[aria-label='快捷导航']");
    const item = scope.locator(".nav-item").filter({ hasText: label }).first();
    await item.waitFor();
    return (await item.locator(".nav-count").innerText()).trim();
  };
  const clickNav = async (section, label) => {
    const scope = section
      ? page.locator(`.home-sidebar section[aria-label="${section}"]`)
      : page.locator(".home-sidebar nav[aria-label='快捷导航']");
    await scope.locator(".nav-item").filter({ hasText: label }).first().click();
  };
  const clearAll = async () => {
    const btn = page.getByRole("button", { name: "清除全部", exact: true });
    if (await btn.count()) await btn.click();
  };
  const closeDialog = async dialog => {
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  };

  try {
    await page.goto(state.base);
    await waitHome();
    await waitWeekly();
    await page.locator(".card[data-project-id]").first().waitFor();

    // 1) 全库统计与导航计数口径
    assert.equal((await page.locator(".stat-total b").innerText()).trim(), "10");
    assert.equal((await page.locator(".stat-active b").innerText()).trim(), "8");
    assert.equal((await page.locator(".stat-archived b").innerText()).trim(), "1");
    assert.equal((await page.locator(".stat-discarded b").innerText()).trim(), "1");
    assert.equal((await page.locator(".stat-lost b").innerText()).trim(), "0");
    assert.equal(await navCount(null, "全部项目"), "9");   // 默认隐藏废弃
    assert.equal(await navCount(null, "最近打开"), "4");
    assert.equal(await navCount(null, "已置顶"), "2");
    assert.equal(await navCount("项目状态", "进行中"), "6");
    assert.equal(await navCount("项目状态", "暂停"), "1");
    assert.equal(await navCount("项目状态", "已完成"), "1");
    assert.equal(await navCount("项目状态", "归档"), "1");
    assert.equal(await navCount("项目状态", "废弃"), "1");
    assert.equal(await navCount("常用标签", "Python"), "3");
    assert.equal(await navCount("常用标签", "Vue"), "5");   // 含归档的 OldVault
    assert.equal(await navCount("常用标签", "C#"), "2");
    assert.equal(await navCount("常用标签", "Go"), "1");
    assert.equal(await cardCount(), 9);
    ok("统计条全库口径与侧栏候选计数、默认隐藏废弃一致");

    // 2) 本周拾光：全部项目逐条列出、颜色对应、提示与两种明细
    assert.match(await page.locator(".week-sub").innerText(), /近 7 天 · 仅本人/);
    assert.equal((await page.locator(".week-big").innerText()).trim(), "11");
    assert.equal(await page.locator(".week-col").count(), 7);
    assert.equal(await page.locator(".week-col.has-commits").count(), 5);
    const weekNames = await page.locator(".week-project .week-project-name").allInnerTexts();
    const weekCounts = await page.locator(".week-project .week-pcount").allInnerTexts();
    assert.deepEqual(weekNames.map(s => s.trim()),
      ["Tracelight", "WindowAnchor", "SkillManager", "NextPaste", "LinuxDoSearch"]);
    assert.deepEqual(weekCounts.map(s => s.trim()), ["4", "3", "2", "1", "1"]);
    assert.equal(await page.locator(".week-project.other").count(), 0);
    assert.doesNotMatch(await page.locator(".week-panel").innerText(), /其他\s*\d+\s*个项目/);
    const dotColor = i => page.locator(".week-project").nth(i).locator(".week-dot")
      .evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(await dotColor(0), "rgb(47, 129, 247)");
    assert.equal(await dotColor(1), "rgb(34, 166, 106)");
    assert.equal(await dotColor(2), "rgb(144, 97, 249)");
    assert.equal(await dotColor(3), "rgb(217, 119, 6)");
    assert.equal(await dotColor(4), "rgb(219, 39, 119)");

    const weekBar = page.locator(".week-col.has-commits").first();
    await weekBar.hover();
    await page.locator(".week-tip").waitFor();
    const tipText = await page.locator(".week-tip").innerText();
    assert.match(tipText, /次提交/);
    assert.match(tipText, /Tracelight|WindowAnchor|SkillManager|NextPaste|LinuxDoSearch/);
    assert.doesNotMatch(tipText, /其他\s*\d+\s*个项目/);
    await weekBar.focus();
    await page.locator(".week-tip").waitFor();

    await page.getByRole("button", { name: "查看明细", exact: true }).click();
    const weekDialog = page.getByRole("dialog", { name: "近 7 天提交明细" });
    await weekDialog.waitFor();
    assert((await weekDialog.locator(".week-detail-day").count()) >= 1);
    assert((await weekDialog.locator(".ct-hash").count()) >= 1);
    await closeDialog(weekDialog);

    await page.locator(".week-col.has-commits").first().click();
    const dayDialog = page.locator(".day-modal");
    await dayDialog.waitFor();
    assert.match(await dayDialog.locator(".day-summary").innerText(), /次提交/);
    assert((await dayDialog.locator(".day-group").count()) >= 1);
    // 日期标签栏：7 天可切换，切换后标题与内容对应当天
    assert.equal(await dayDialog.locator(".day-tab").count(), 7);
    assert.equal(await dayDialog.locator(".day-tab.on").count(), 1);
    const targetTab = dayDialog.locator(".day-tab:not(.on):not(.empty)").first();
    const targetDate = (await targetTab.getAttribute("title")).split(" · ")[0];
    await targetTab.click();
    await page.waitForFunction(d => (document.querySelector("#day-title") || {})
      .textContent.includes(d), targetDate);
    assert.match(await dayDialog.locator("#day-title").innerText(), new RegExp(targetDate));
    await closeDialog(dayDialog);
    ok("本周拾光全部项目逐条列出、稳定配色、悬停/聚焦提示、7 天明细与当日明细");

    // 3) 折叠记忆
    await page.locator(".week-toggle").click();
    assert.equal(await page.locator("#week-body").isVisible(), false);
    await page.reload();
    await waitHome();
    await waitWeekly();
    assert.equal(await page.locator("#week-body").isVisible(), false);
    await page.locator(".week-toggle").click();
    assert.equal(await page.locator("#week-body").isVisible(), true);
    ok("本周拾光折叠状态刷新后保持");

    // 4) 状态 + 标签 + 搜索组合筛选，计数与结果一致
    await clickNav("项目状态", "进行中");
    await waitCards(6);
    assert.match(await page.locator(".active-filters").innerText(), /状态：进行中/);
    await clickNav("常用标签", "Vue");
    await waitCards(3);
    assert.match(await page.locator(".active-filters").innerText(), /标签：Vue/);
    const search = page.getByRole("searchbox", { name: "搜索项目" });
    await search.fill("skill");
    await waitCards(1);
    assert.match(await page.locator(".card h3").first().innerText(), /SkillManager/);
    await clearAll();
    await waitCards(9);
    await clickNav("项目状态", "废弃");
    await waitCards(1);
    assert.match(await page.locator(".card h3").first().innerText(), /Scratch/);
    await clearAll();
    await waitCards(9);
    ok("状态 + 标签 + 搜索组合、废弃显式可见与清除全部");

    // 5) 排序：选择“最近打开”立即重排并保存
    const sortSelect = page.locator(".filter-bar .lsel").first();
    await sortSelect.locator(".lsel-trigger").click();
    const sortSaved = page.waitForResponse(r => r.url().endsWith("/api/settings")
      && r.request().method() === "PUT" && r.status() === 200);
    await page.getByRole("option", { name: "最近打开", exact: true }).click();
    await sortSaved;
    assert.equal(await page.evaluate(() => window.__tlHomeVM.sortBy), "最近打开");
    ok("排序下拉选择最近打开并持久化");

    // 6) 真实拖动并刷新验证（同状态、同为非置顶的 Tracelight / NextPaste）
    const tlId = byName["Tracelight"].id;
    const npId = byName["NextPaste"].id;
    const orderBefore = await page.locator(".card[data-project-id]").evaluateAll(
      els => els.map(e => Number(e.dataset.projectId)));
    assert(orderBefore.indexOf(tlId) < orderBefore.indexOf(npId));
    const target = page.locator(`.card[data-project-id="${npId}"]`);
    const box = await target.boundingBox();
    const dragSaved = page.waitForResponse(r => r.url().endsWith("/api/settings")
      && r.request().method() === "PUT" && r.status() === 200, { timeout: 15000 });
    await page.locator(`.card[data-project-id="${tlId}"] .project-drag`)
      .dragTo(target, { targetPosition: { x: box.width - 16, y: 40 } });
    await dragSaved;
    await page.waitForFunction(({ a, b }) => {
      const order = [...document.querySelectorAll(".card[data-project-id]")]
        .map(el => Number(el.dataset.projectId));
      return order.indexOf(b) < order.indexOf(a);
    }, { a: tlId, b: npId });
    const orderAfter = await page.locator(".card[data-project-id]").evaluateAll(
      els => els.map(e => Number(e.dataset.projectId)));
    await page.reload();
    await waitHome();
    await waitWeekly();
    const orderReload = await page.locator(".card[data-project-id]").evaluateAll(
      els => els.map(e => Number(e.dataset.projectId)));
    assert.deepEqual(orderReload, orderAfter);
    ok("卡片真实拖动后顺序改变并刷新保持");

    // 7) 最近打开视图：只含有记录项目、按访问时间倒序、拖动暂停
    await clickNav(null, "最近打开");
    await waitCards(4);
    assert.equal(await page.locator(".project-drag").first().isDisabled(), true);
    const recentFirst = await page.locator(".card h3").first().innerText();
    assert.match(recentFirst, /WindowAnchor/);   // 置顶优先，随后才是今天打开的 Tracelight
    await clickNav(null, "全部项目");
    await waitCards(9);
    ok("最近打开视图保留置顶/状态分组并暂停拖动");

    // 8) 选中无访问记录的 SuKe 进入详情，返回后记录“今天”，最近打开计数 +1
    const sukeId = byName["SuKe"].id;
    const visit = page.waitForResponse(r =>
      r.url().includes(`/api/projects/${sukeId}/visit`)
      && r.request().method() === "POST" && r.status() === 200, { timeout: 20000 });
    await page.locator(`.card[data-project-id="${sukeId}"]`).evaluate(el => el.click());
    await page.waitForURL(`**/project/${sukeId}`, { timeout: 20000 });
    await page.waitForFunction(() => window.__tlProjectVM && window.__tlProjectVM.p);
    await visit;
    await page.goBack();
    await waitHome();
    await waitWeekly();
    await page.waitForFunction(id => {
      const card = document.querySelector(`.card[data-project-id="${id}"]`);
      return card && card.querySelector(".open-time")?.textContent.includes("今天");
    }, sukeId, { timeout: 20000 });
    assert.equal(await navCount(null, "最近打开"), "5");
    assert.match(await page.locator(`.card[data-project-id="${sukeId}"] .open-time`).innerText(),
                 /上次打开：今天/);
    ok("软导航进入详情后记录访问，返回首页看到今天且最近打开 +1");

    // 9) 导航配置：从管理界面添加 Rust 标签，保存后立即可筛选
    await page.getByRole("button", { name: "管理导航", exact: true }).click();
    const navDialog = page.getByRole("dialog", { name: "管理导航" });
    await navDialog.waitFor();
    await navDialog.getByRole("button", { name: /#Rust/ }).click();
    const navSaved = page.waitForResponse(r => r.url().endsWith("/api/settings")
      && r.request().method() === "PUT" && r.status() === 200);
    await navDialog.getByRole("button", { name: "保存导航配置", exact: true }).click();
    await navSaved;
    await navDialog.waitFor({ state: "hidden" });
    const rustNav = page.locator('.home-sidebar section[aria-label="常用标签"] .nav-item')
      .filter({ hasText: "Rust" });
    await rustNav.waitFor();
    assert.equal((await rustNav.locator(".nav-count").innerText()).trim(), "1");
    await rustNav.click();
    await waitCards(1);
    assert.match(await page.locator(".card h3").first().innerText(), /SkillManager/);
    await clearAll();
    await waitCards(9);
    ok("管理导航添加常用标签后生效并可用于点击筛选");

    // 10) 多主题、多宽度截图与横向溢出检查
    await page.evaluate(() => window.setThemePref("light"));
    for (const width of [1920, 1440, 1280, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(120);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `light/${width} 横向溢出 ${overflow}`);
      await page.screenshot({
        path: path.join(output, `home-final-${width}-light.png`), fullPage: true,
      });
    }
    await page.evaluate(() => window.setThemePref("dark"));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(120);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `dark/${width} 横向溢出 ${overflow}`);
      await page.screenshot({
        path: path.join(output, `home-final-${width}-dark.png`), fullPage: true,
      });
    }
    await page.evaluate(() => window.setThemePref("light"));
    ok("亮色 1920/1440/1280/1024/768/390 与暗色 1440/390 无横向溢出并留存截图");

    if (errors.length) throw new Error("控制台错误：\n" + errors.join("\n"));
    if (failed.length) throw new Error("失败请求：\n" + failed.join("\n"));
    fs.writeFileSync(path.join(output, "home-final-browser.json"),
                     JSON.stringify({ results, errors, failed, weekly }, null, 2));
    console.log("[PASS] F6 首页完整交互、截图与控制台检查");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
