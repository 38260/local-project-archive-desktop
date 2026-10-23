// 详情 F1 浏览器回归：紧凑头部、Logo、信息去重、主次操作与更多信息。
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
  assert(project, "缺少 Tracelight 样例");
  const noLaunch = listing.projects.find(p => p.name === "SuKe");
  assert(noLaunch, "缺少 SuKe 样例");

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  try {
    await page.goto(`${state.base}/project/${project.id}`);
    await page.waitForFunction(() => window.__tlProjectVM && window.__tlProjectVM.p);
    await page.waitForFunction(() => window.__tlProjectVM.launch !== null);

    assert.equal((await page.locator(".proj-card h1").innerText()).trim(), "Tracelight");
    assert.equal((await page.locator(".head-logo").innerText()).trim(), "TR");
    assert.equal(await page.locator(".head-logo").evaluate(el => getComputedStyle(el).backgroundColor),
                 "rgb(144, 97, 249)");   // id=3 → 紫色
    assert.match(await page.locator(".alias-inline").first().innerText(), /归迹/);
    assert.match(await page.locator(".info-intro").innerText(), /本地项目归档与快速启动/);
    assert.equal(await page.locator(".head-chips .cat-chip").count(), 1);
    assert((await page.locator(".head-chips .tag").count()) >= 3);
    assert.match(await page.locator(".head-branch").innerText(), /main/);

    // 路径只出现一次，且提供行内复制
    assert.equal(await page.locator(".proj-card-path").count(), 1);
    assert.equal(await page.getByRole("button", { name: "复制路径", exact: true }).count(), 0);

    // 主次操作：启动为主，编辑器/资源管理器为次级；编辑档案移入更多菜单
    const launch = page.locator(".head-actions .launch-split .btn.primary").first();
    await launch.waitFor();
    assert.equal(await launch.isEnabled(), true);
    assert.equal(await page.locator(".head-actions .head-secondary").filter({ hasText: "编辑器打开" }).count(), 1);
    assert.equal(await page.locator(".head-actions .head-secondary").filter({ hasText: "资源管理器" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "复制路径", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "编辑档案", exact: true }).count(), 0);
    await page.locator(".head-actions .more-wrap > .btn").click();
    const more = page.locator(".head-actions .more-list");
    await more.waitFor();
    for (const label of ["编辑档案", "重新解析", "置顶", "导出 HTML", "删除档案"]) {
      assert.equal(await more.getByRole("menuitem", { name: label, exact: false }).count(), 1, label);
    }
    await page.keyboard.press("Escape");

    // 更多信息：创建/修改/上次打开 + Git 元信息
    await page.getByRole("button", { name: /更多信息/ }).click();
    const moreInfo = page.locator("#head-more");
    assert.equal(await moreInfo.isVisible(), true);
    assert.match(await moreInfo.innerText(), /磁盘创建/);
    assert.match(await moreInfo.innerText(), /磁盘修改/);
    assert.match(await moreInfo.innerText(), /上次打开/);
    assert.match(await moreInfo.innerText(), /当前分支/);
    assert.match(await moreInfo.innerText(), /仓库提交总数/);
    assert.match(await moreInfo.innerText(), /最近提交/);
    assert((await page.locator(".dbadge").count()) >= 2);
    await page.screenshot({ path: path.join(output, "detail-f1-1440.png"), fullPage: true });

    // 无启动入口的项目：主按钮应禁用并说明原因
    await page.goto(`${state.base}/project/${noLaunch.id}`);
    await page.waitForFunction(() => window.__tlProjectVM && window.__tlProjectVM.launch !== null);
    const disabled = page.locator(".head-actions > .btn.primary");
    assert.equal(await disabled.isDisabled(), true);
    assert.match(await disabled.getAttribute("title"), /启动入口/);

    assert.deepEqual(errors, []);
    console.log("[PASS] F1 头条：Logo/简介/标签/分支/唯一路径、主次操作、更多信息与无启动降级");
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
