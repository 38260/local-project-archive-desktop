// 详情页 F5 最终验收：顶栏/状态/复制/更多菜单、访问不重复、多分区、多主题多宽度截图。
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

(async () => {
  const listing = await (await fetch(state.base + "/api/projects")).json();
  const project = listing.projects.find(p => p.name === "Tracelight");
  assert(project);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce",
  });
  await context.addInitScript(() => {
    window.testClipboardWrites = [];
    if (navigator.clipboard) {
      Object.defineProperty(navigator.clipboard, "writeText", {
        value: async text => { window.testClipboardWrites.push(text); },
        configurable: true,
      });
    }
  });
  const page = await context.newPage();
  const errors = [];
  const failed = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("requestfailed", r => failed.push("failed: " + r.url()));
  page.on("response", r => { if (r.status() >= 400) failed.push(`HTTP ${r.status()}: ${r.url()}`); });
  const results = [];
  const ok = label => { results.push(label); console.log("[PASS]", label); };
  const waitReady = () => page.waitForFunction(() => {
    const vm = window.__tlProjectVM;
    return vm && vm.p && vm.launch !== null && vm.readme !== null
      && vm.recentActivityLoading === false && vm.recentCommitsLoading === false;
  }, null, { timeout: 30000 });
  const tab = name => page.locator(".tab-nav .tab-btn").filter({ hasText: name });

  try {
    const visit = page.waitForResponse(r =>
      r.url().includes(`/api/projects/${project.id}/visit`)
      && r.request().method() === "POST" && r.status() === 200, { timeout: 20000 });
    await page.goto(`${state.base}/project/${project.id}`);
    await visit;
    await waitReady();

    // 1) 顶栏与品牌和首页一致
    assert.match(await page.locator(".topbar .logo").innerText(), /归迹拾光/);
    assert.equal(await page.locator(".topbar button[aria-controls='tree-drawer']").count(), 1);
    assert.equal(await page.getByRole("button", { name: "设置", exact: true }).count(), 1);
    assert.equal(await page.locator(".topbar .brand-mark").count(), 1);
    assert.equal(await page.locator(".head-actions .btn.primary").count() >= 1, true);
    assert.equal(await page.locator(".head-actions .btn.primary.head-secondary").count(), 0);
    ok("顶栏品牌/tabbar 入口/目录树/设置/主题与主次按钮层级");

    // 2) 行内复制路径（不写入真实系统剪贴板）
    await page.locator(".proj-card-path").click();
    const writes = await page.evaluate(() => window.testClipboardWrites);
    assert.equal(writes.at(-1), project.path);
    assert.match(await page.locator(".toast").last().innerText(), /路径已复制/);

    // 3) 头部状态修改并恢复
    await page.locator(".head-status .lsel-trigger").click();
    let saving = page.waitForResponse(r => r.url().endsWith(`/api/projects/${project.id}`)
      && r.request().method() === "PUT" && r.status() === 200);
    await page.getByRole("option", { name: "暂停", exact: true }).click();
    await saving;
    assert.equal(await page.evaluate(() => window.__tlProjectVM.p.status), "暂停");
    assert.match(await page.locator(".toast").last().innerText(), /状态已更新为「暂停」/);
    await page.locator(".head-status .lsel-trigger").click();
    saving = page.waitForResponse(r => r.url().endsWith(`/api/projects/${project.id}`)
      && r.request().method() === "PUT" && r.status() === 200);
    await page.getByRole("option", { name: "进行中", exact: true }).click();
    await saving;
    assert.equal(await page.evaluate(() => window.__tlProjectVM.p.status), "进行中");

    // 4) 更多菜单保留全部能力
    await page.locator(".head-actions .more-wrap > .btn").click();
    const menu = page.locator(".head-actions .more-list");
    await menu.waitFor();
    for (const label of ["编辑档案", "重新解析", "置顶", "导出 HTML", "删除档案"]) {
      assert.equal(await menu.getByRole("menuitem", { name: label, exact: false }).count(), 1, label);
    }
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    ok("路径内联复制、状态修改/恢复、更多菜单能力完整");

    // 5) 分区切换不应重复记录访问
    const openedBefore = (await (await fetch(`${state.base}/api/projects/${project.id}`)).json()).last_opened_at;
    assert(openedBefore);
    for (const name of ["启动与运行", "开发记录", "项目资料", "概览", "开发记录", "概览"]) {
      await tab(name).click();
      await page.waitForTimeout(80);
    }
    const openedAfter = (await (await fetch(`${state.base}/api/projects/${project.id}`)).json()).last_opened_at;
    assert.equal(openedAfter, openedBefore);
    ok("分区切换不重复产生访问事件");

    // 5b) README 相对链接仍在应用内预览（文件预览能力未因抽屉改造丢失）
    await tab("项目资料").click();
    await page.locator("#sec-readme .md-body a", { hasText: "开发说明" }).click();
    const docModal = page.locator(".doc-modal");
    await docModal.waitFor();
    await page.locator(".doc-md").waitFor();
    assert.match(await page.locator(".doc-md").innerText(), /应用内文档预览/);
    await page.keyboard.press("Escape");
    await docModal.waitFor({ state: "hidden" });
    ok("README 相对链接仍通过应用内文档查看器预览");

    // 6) 各分区 1440 截图与横向溢出
    const shots = [
      ["概览", "overview"], ["启动与运行", "launch"],
      ["开发记录", "records"], ["项目资料", "materials"],
    ];
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.setThemePref("light"));
    // 截图前等测试操作产生的 toast / 自动更新条自然消失，保留真实界面而非遮挡物
    await page.waitForFunction(() => !document.querySelector(".toast")
      && !document.querySelector(".auto-refresh-strip"), null, { timeout: 10000 }).catch(() => {});
    for (const [label, key] of shots) {
      await tab(label).click();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `${label} 1440 横向溢出 ${overflow}`);
      await page.screenshot({ path: path.join(output, `detail-${key}-1440-light.png`), fullPage: true });
    }

    // 7) 概览多宽度（亮色）与暗色截图
    await tab("概览").click();
    for (const width of [1920, 1440, 1280, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(120);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `概览 light/${width} 横向溢出 ${overflow}`);
      await page.screenshot({ path: path.join(output, `detail-overview-${width}-light.png`), fullPage: true });
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => window.setThemePref("dark"));
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `概览 dark/${width} 横向溢出 ${overflow}`);
      await page.screenshot({ path: path.join(output, `detail-overview-${width}-dark.png`), fullPage: true });
    }
    await page.evaluate(() => window.setThemePref("light"));

    // 8) 390px 下四个分区均无横向溢出
    await page.setViewportSize({ width: 390, height: 900 });
    for (const [label] of shots) {
      await tab(label).click();
      await page.waitForTimeout(100);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `${label} 390 横向溢出 ${overflow}`);
    }
    await tab("概览").click();
    ok("四分区 1440 截图、概览 6 宽度亮色 + 2 宽度暗色、390 四分区无横向溢出");

    const unexpected = errors.filter(e => !/Failed to load resource|status of 500/i.test(e));
    assert.deepEqual(unexpected, []);
    assert.deepEqual(failed, []);
    fs.writeFileSync(path.join(output, "detail-final-browser.json"),
                     JSON.stringify({ results, errors, failed }, null, 2));
    console.log("[PASS] F5 详情最终验收：顶栏/操作/访问/分区/多主题多宽度截图与控制台检查");
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
