// 详情 F3 浏览器回归：概览真实数据、7 日窗口、跳转链路、缺邮箱/非 Git/空窗口/失败重试。
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

async function j(url, init) {
  const r = await fetch(url, init);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  const listing = (await j(state.base + "/api/projects")).body.projects;
  const byName = Object.fromEntries(listing.map(p => [p.name, p]));
  const project = byName["Tracelight"];
  assert(project);
  const heat = (await j(`${state.base}/api/projects/${project.id}/heatmap?window_days=7&tz=local&authors=mine`)).body;
  assert.equal(heat.total, 4);
  assert.equal(heat.identity_required, false);
  assert.equal(Object.values(heat.days).reduce((a, b) => a + b, 0), 4);
  assert.equal(heat.window_days, 7);
  const quiet = (await j(`${state.base}/api/projects/${byName["QuietRepo"].id}/heatmap?window_days=7&tz=local&authors=mine`)).body;
  assert.equal(quiet.is_repo, true);
  assert.equal(quiet.total, 0);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  const waitReady = () => page.waitForFunction(() => {
    const vm = window.__tlProjectVM;
    return vm && vm.p && vm.readme !== null && vm.launch !== null
      && vm.recentActivityLoading === false && vm.recentCommitsLoading === false
      && vm.notesLoading === false && vm.recentActivity;
  }, null, { timeout: 30000 });
  const tab = name => page.locator(".tab-nav .tab-btn").filter({ hasText: name });
  const activeTab = () => page.evaluate(() => window.__tlProjectVM.activeTab);

  try {
    await page.goto(`${state.base}/project/${project.id}`);
    await waitReady();

    // 1) 概览真实数据：4 次 / 3 个活跃日 / 7 个桶 / 3 条最近提交 / 3 条笔记 / 启动 / README
    assert.match(await page.locator(".ov-summary").innerText(), /4.*次本人提交.*3.*个活跃日/s);
    assert.equal(await page.locator(".ov-chart-col").count(), 7);
    const nums = await page.locator(".ov-chart-num").allInnerTexts();
    assert.equal(nums.map(Number).reduce((a, b) => a + b, 0), 4);
    assert.equal(nums.filter(n => Number(n) === 0).length >= 4, true, "零提交日期必须保留");
    const firstBarBg = await page.locator(".ov-chart-bar").nth(3)
      .evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(firstBarBg, "rgb(144, 97, 249)");   // id=3 紫色项目主色
    assert.equal(await page.locator(".ov-commit").count(), 3);
    assert.equal(await page.locator(".ov-notes .ov-note").count(), 3);
    assert((await page.locator(".ov-launch-card").count()) >= 2);
    assert.equal(await page.locator(".ov-launch-card .lb-primary").count(), 1);
    assert.match(await page.locator(".ov-readme-text").innerText(), /本地项目归档与快速启动/);
    assert.match(await page.locator("#ov-progress .count").innerText(), /近 7 天 · 仅本人/);

    // 2) 全部入口跳转链路
    await page.locator("#ov-progress").getByRole("button", { name: /全部提交/ }).click();
    assert.equal(await activeTab(), "records");
    assert.equal(await page.locator("#sec-commits").isVisible(), true);

    await tab("概览").click();
    await page.locator("#ov-notes").getByRole("button", { name: /查看全部笔记/ }).click();
    assert.equal(await activeTab(), "records");
    assert.equal(await page.locator("#sec-notes").isVisible(), true);
    assert.equal(await page.locator("#sec-notes .record-body").isVisible(), true);

    await tab("概览").click();
    await page.locator("#ov-notes").getByRole("button", { name: /新增笔记/ }).click();
    assert.equal(await activeTab(), "records");
    await page.waitForFunction(() => {
      const el = document.activeElement;
      return el && el.tagName === "TEXTAREA" && el.closest("#sec-notes");
    }, null, { timeout: 3000 });

    await tab("概览").click();
    await page.locator("#ov-launch").getByRole("button", { name: /全部启动项/ }).click();
    assert.equal(await activeTab(), "launch");
    assert.equal(await page.locator("#sec-launch").isVisible(), true);

    await tab("概览").click();
    await page.locator("#ov-readme").getByRole("button", { name: /阅读全文/ }).click();
    assert.equal(await activeTab(), "materials");
    assert.equal(await page.locator("#sec-readme").isVisible(), true);

    await tab("概览").click();
    await page.locator("#ov-readme").getByRole("button", { name: /编辑项目描述/ }).click();
    assert.equal(await activeTab(), "records");
    assert.equal(await page.locator("#sec-desc .record-body").isVisible(), true);

    await tab("概览").click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(output, "detail-f3-1440.png"), fullPage: true });

    // 3) 缺少邮箱：明确引导，不伪造 0 贡献
    await j(state.base + "/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "git.author_emails": [] }),
    });
    await page.reload();
    await page.waitForFunction(() => window.__tlProjectVM && window.__tlProjectVM.p
      && window.__tlProjectVM.recentActivityLoading === false);
    assert.match(await page.locator("#ov-progress .ov-empty").innerText(), /还没有配置「我的 Git 邮箱」/);
    assert.match(await page.locator("#ov-progress .ov-empty").innerText(), /设置 Git 邮箱/);
    await j(state.base + "/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "git.author_emails": ["me@example.com"] }),
    });

    // 4) 非 Git 与真实空窗口
    await page.goto(`${state.base}/project/${byName["SuKe"].id}`);
    await page.waitForFunction(() => window.__tlProjectVM && window.__tlProjectVM.p
      && window.__tlProjectVM.recentActivityLoading === false);
    assert.match(await page.locator("#ov-progress .ov-empty").innerText(), /不是 Git 仓库/);

    await page.goto(`${state.base}/project/${byName["QuietRepo"].id}`);
    await page.waitForFunction(() => window.__tlProjectVM && window.__tlProjectVM.p
      && window.__tlProjectVM.recentActivityLoading === false
      && window.__tlProjectVM.recentCommitsLoading === false);
    assert.match(await page.locator(".ov-summary").innerText(), /0.*次本人提交.*0.*个活跃日/s);
    assert.equal(await page.locator(".ov-chart-col").count(), 7);
    assert.match(await page.locator("#ov-progress .section-note").last().innerText(), /近 7 天没有本人提交/);

    // 5) 请求失败 → 明确错误与重试，不伪装成 0
    await j(state.base + "/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "git.author_emails": ["me@example.com"] }),
    });
    let failOnce = true;
    await page.route(/\/api\/projects\/\d+\/heatmap\?/, async route => {
      if (route.request().url().includes("window_days=7") && failOnce) {
        failOnce = false;
        await route.fulfill({ status: 500, contentType: "application/json",
                              body: JSON.stringify({ detail: "模拟读取失败" }) });
      } else {
        await route.continue();
      }
    });
    await page.goto(`${state.base}/project/${project.id}`);
    await page.waitForFunction(() => window.__tlProjectVM && window.__tlProjectVM.p
      && window.__tlProjectVM.recentActivityLoading === false);
    assert.match(await page.locator("#ov-progress .panel-compact-bar").innerText(), /读取失败/);
    await page.locator("#ov-progress .panel-compact-bar").getByRole("button", { name: "重试" }).click();
    await page.waitForFunction(() => {
      const vm = window.__tlProjectVM;
      return vm.recentActivityLoading === false && vm.recentActivity
        && vm.recentActivityError === "";
    }, null, { timeout: 10000 });
    assert.match(await page.locator(".ov-summary").innerText(), /4.*次本人提交/);
    await page.unroute(/\/api\/projects\/\d+\/heatmap\?/);

    // 故障注入会留下浏览器自身的 500 资源日志；只容忍这一条已知噪音
    const unexpected = errors.filter(e => !/Failed to load resource|status of 500/i.test(e));
    assert.deepEqual(unexpected, []);
    console.log("[PASS] F3 概览：7 日真实统计/笔记/启动/README、全部跳转、缺邮箱/非 Git/空窗口/失败重试");
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
