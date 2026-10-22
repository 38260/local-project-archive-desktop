// 详情 F4 浏览器回归：目录树按需抽屉、懒加载、焦点/Esc、文件复制/预览、宽度释放与偏好。
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
  const treeRequests = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("request", r => { if (/\/api\/projects\/\d+\/tree/.test(r.url())) treeRequests.push(r.url()); });
  const waitReady = () => page.waitForFunction(() => window.__tlProjectVM && window.__tlProjectVM.p);
  const treeButton = () => page.locator(".topbar button[aria-controls='tree-drawer']");
  const drawer = () => page.locator("#tree-drawer");

  try {
    await page.goto(`${state.base}/project/${project.id}`);
    await waitReady();
    await page.waitForTimeout(350);
    assert.equal(await drawer().count(), 0);
    assert.equal(await page.evaluate(() => window.__tlProjectVM.tree), undefined);
    assert.equal(treeRequests.length, 0, "未打开目录树时不应扫描");
    assert.equal(await page.locator(".detail-side").count(), 0);
    assert.equal(await page.locator(".detail-layout").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length), 2);
    const mainWidthClosed = await page.locator(".detail-main").evaluate(el => el.getBoundingClientRect().width);

    // 1) 懒加载 + 焦点进入
    await treeButton().click();
    await drawer().waitFor();
    await page.locator("#tree-drawer .tree .t-file").first().waitFor();
    assert.equal(treeRequests.length, 1);
    assert.equal(await page.evaluate(() => {
      const d = document.getElementById("tree-drawer");
      return !!d && d.contains(document.activeElement);
    }), true);
    assert.equal(await page.evaluate(() => window.__tlProjectVM.tree && window.__tlProjectVM.tree.truncated), false);
    assert.equal(await page.locator("#tree-drawer .tree .t-name").filter({ hasText: "README.md" }).count() >= 1, true);

    // 2) 展开目录、单击复制、双击预览；预览关闭后抽屉仍在
    const dir = page.locator("#tree-drawer .tree .t-dir").first();
    const beforeChildren = await dir.locator("ul li").count();
    await dir.locator(".t-name").click();
    assert((await dir.locator("ul li").count()) >= beforeChildren);
    const readmeFile = page.locator("#tree-drawer .tree .t-file").filter({ hasText: "README.md" }).first();
    await readmeFile.locator(".t-name").click();
    await page.waitForTimeout(350);
    const writes = await page.evaluate(() => window.testClipboardWrites);
    assert.equal(writes.length, 1);
    assert.match(writes[0], /README\.md$/);
    assert.match(await page.locator(".toast").last().innerText(), /路径已复制/);
    // 双击走系统默认应用：拦截 open-file，避免测试机真的拉起外部程序
    let openFileCalled = false;
    await page.route(/\/api\/projects\/\d+\/open-file$/, async route => {
      openFileCalled = true;
      await route.fulfill({ status: 200, contentType: "application/json",
                            body: JSON.stringify({ ok: true, name: "README.md" }) });
    });
    await readmeFile.locator(".t-name").dblclick();
    await page.waitForTimeout(500);
    assert.equal(openFileCalled, true);
    assert.match(await page.locator(".toast").last().innerText(), /已用默认应用打开/);
    await page.unroute(/\/api\/projects\/\d+\/open-file$/);
    assert.equal(await drawer().isVisible(), true);
    await page.screenshot({ path: path.join(output, "detail-f4-tree.png") });

    // 3) Esc 关闭并把焦点还给顶部按钮；正文宽度不变（始终释放右列）
    await page.keyboard.press("Escape");
    await drawer().waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".topbar button[aria-controls='tree-drawer']")), true);
    const mainWidthOpen = await page.locator(".detail-main").evaluate(el => el.getBoundingClientRect().width);
    assert(Math.abs(mainWidthOpen - mainWidthClosed) < 2);

    // 4) 偏好：打开状态刷新保持；关闭后刷新不再出现
    await treeButton().click();
    await drawer().waitFor();
    await page.reload();
    await waitReady();
    await drawer().waitFor();
    await page.locator("#tree-drawer .tree .t-file").first().waitFor();
    await page.keyboard.press("Escape");
    await drawer().waitFor({ state: "detached" });
    await page.reload();
    await waitReady();
    await page.waitForTimeout(250);
    assert.equal(await drawer().count(), 0);

    // 5) 键盘打开/关闭
    await treeButton().focus();
    await page.keyboard.press("Enter");
    await drawer().waitFor();
    assert.equal(await page.evaluate(() => document.getElementById("tree-drawer").contains(document.activeElement)), true);
    await page.keyboard.press("Escape");
    await drawer().waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".topbar button[aria-controls='tree-drawer']")), true);

    // 6) 窄屏抽屉与页面无横向溢出
    await page.setViewportSize({ width: 390, height: 900 });
    await treeButton().click();
    await drawer().waitFor();
    const boxes = await page.evaluate(() => {
      const d = document.getElementById("tree-drawer").getBoundingClientRect();
      return { left: d.left, right: d.right, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    assert(boxes.left >= 0 && boxes.right <= 391);
    assert(boxes.overflow <= 1);
    await page.keyboard.press("Escape");

    assert.deepEqual(errors, []);
    console.log("[PASS] F4 目录树按需抽屉：懒加载/焦点/Esc/复制/预览/宽度释放/偏好/窄屏");
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
