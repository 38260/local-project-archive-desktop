// 详情 F2 浏览器回归：四分区、页内锚点、草稿/筛选/折叠/阅读位置保护、旧锚点与离开确认。
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
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  const waitReady = () => page.waitForFunction(() => {
    const vm = window.__tlProjectVM;
    return vm && vm.p && vm.launch !== null && vm.readme !== null;
  }, null, { timeout: 30000 });
  const tab = name => page.locator(".tab-nav .tab-btn").filter({ hasText: name });
  const anchor = name => page.locator(".page-toc button").filter({ hasText: name });
  const activeTab = () => page.evaluate(() => window.__tlProjectVM.activeTab);

  try {
    await page.goto(`${state.base}/project/${project.id}`);
    await waitReady();

    // 1) 默认概览；四个主分区常驻导航
    assert.equal(await activeTab(), "overview");
    assert.equal(await page.locator("#overview-panel").isVisible(), true);
    assert.equal(await page.locator("#sec-launch").isVisible(), false);
    assert.equal(await page.locator("#sec-commits").isVisible(), false);
    assert.equal(await page.locator(".tab-nav .tab-btn").count(), 4);
    assert.equal(await page.locator(".tab-nav .tab-btn.on").innerText(), "概览");

    // 2) 分区切换与“本页内容”锚点
    await tab("启动与运行").click();
    assert.equal(await activeTab(), "launch");
    assert.equal(await page.locator("#sec-launch").isVisible(), true);
    assert.equal(await page.locator("#overview-panel").isVisible(), false);
    // 没有运行记录时不显示空的“运行历史”锚点
    assert.deepEqual((await page.locator(".page-toc button").allInnerTexts()).map(s => s.trim()),
                     ["启动项与说明"]);

    await tab("开发记录").click();
    assert.equal(await activeTab(), "records");
    await anchor("项目描述").click();
    await page.locator("#sec-desc .record-body").waitFor({ state: "visible" });
    const desc = page.locator("#sec-desc .md-editor");
    await desc.fill("F2 草稿保护测试：切换分区后这是同一份未保存描述。");
    assert.equal(await page.evaluate(() => window.__tlProjectVM.descDirty), true);

    // 3) 笔记 / 变更日志 / 启动说明草稿均保留
    await anchor("开发笔记").click();
    await page.locator("#sec-notes .record-body").waitFor({ state: "visible" });
    await page.locator("#sec-notes").getByRole("button", { name: /新建笔记/ }).click();
    const noteDraft = page.locator("#sec-notes textarea.md-editor").last();
    await noteDraft.fill("F2 笔记草稿：切换分区后仍在。");

    await anchor("变更日志").click();
    await page.locator("#sec-changelogs .record-body").waitFor({ state: "visible" });
    await page.locator("#sec-changelogs").getByRole("button", { name: /新增条目/ }).click();
    await page.locator("#sec-changelogs input[type='text']").fill("F2 日志草稿标题");
    await page.locator("#sec-changelogs textarea.md-editor").fill("F2 日志草稿正文：切换后仍在。");

    await tab("启动与运行").click();
    await page.locator("#sec-launch").getByRole("button", { name: /编辑说明|写启动说明/ }).click();
    const launchNote = page.locator("#sec-launch .launch-note-edit textarea");
    await launchNote.fill("F2 启动说明草稿：切换后仍在。");

    // 4) 作者筛选与折叠状态保留
    await tab("开发记录").click();
    await page.locator("#sec-commits .tfilter").filter({ hasText: "全部作者" }).click();
    assert.equal(await page.evaluate(() => window.__tlProjectVM.commitAuthors), "all");
    await tab("概览").click();
    await tab("开发记录").click();
    assert.equal(await page.evaluate(() => window.__tlProjectVM.commitAuthors), "all");
    assert.equal(await page.locator("#sec-commits .commit-filters").first()
      .locator(".tfilter.on").innerText(), "全部作者");
    assert.equal(await desc.inputValue(), "F2 草稿保护测试：切换分区后这是同一份未保存描述。");
    assert.equal(await noteDraft.inputValue(), "F2 笔记草稿：切换分区后仍在。");
    assert.equal(await page.locator("#sec-changelogs input[type='text']").inputValue(), "F2 日志草稿标题");
    assert.equal(await page.locator("#sec-changelogs textarea.md-editor").inputValue(), "F2 日志草稿正文：切换后仍在。");
    assert.equal(await page.locator("#sec-desc .record-body").isVisible(), true);
    assert.equal(await page.locator("#sec-notes .record-body").isVisible(), true);

    await tab("启动与运行").click();
    assert.equal(await launchNote.inputValue(), "F2 启动说明草稿：切换后仍在。");

    // 5) 分区阅读位置恢复
    await tab("开发记录").click();
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForTimeout(120);
    await tab("启动与运行").click();
    await page.waitForTimeout(120);
    await tab("开发记录").click();
    await page.waitForTimeout(250);
    const y = await page.evaluate(() => window.scrollY);
    assert(Math.abs(y - 700) < 12, `阅读位置应恢复，实际 ${y}`);

    // 6) 离开确认仍然有效（有未保存笔记/日志）
    await page.locator(".detail-back").click();
    const dialog = page.locator(".confirm-modal");
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /离开详情页/);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert(page.url().includes(`/project/${project.id}`));

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(output, "detail-f2-1440.png"), fullPage: true });

    // 7) 旧锚点深链：先打开分区再定位
    await page.goto(`${state.base}/project/${project.id}#sec-commits`);
    await waitReady();
    await page.waitForFunction(() => window.__tlProjectVM.activeTab === "records");
    assert.equal(await page.locator("#sec-commits").isVisible(), true);
    await page.waitForFunction(() => {
      const el = document.getElementById("sec-commits");
      return !!el && Math.abs(el.getBoundingClientRect().top) < 220;
    }, null, { timeout: 4000 });

    assert.deepEqual(errors, []);
    console.log("[PASS] F2 四分区/锚点/草稿与筛选保护/阅读位置/离开确认/旧锚点深链");
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
