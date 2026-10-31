// README 截图重拍：在演示台（tmp_demo_harness.py）之上按 16 个场景截图，
// 直接覆盖 docs/screenshots/ 下的同名文件（02 换成新的本周拾光热力图）。
// 用法：node tools/tmp_demo_shots.cjs <state.json>（在演示台内运行，TL_SHOTS=输出目录）
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const OUT = process.env.TL_SHOTS;
assert(OUT && fs.existsSync(OUT), "TL_SHOTS 目录不存在");
const shot = (page, name, opts = {}) =>
  page.screenshot({ path: path.join(OUT, name), ...opts });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium_launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  const errorsSnapshot = () => [...errors];

  try {
    // ---------- 首页 ----------
    await page.goto(state.base + "/");
    await page.waitForFunction(() => window.__tlHomeVM && !window.__tlHomeVM.loading,
      null, { timeout: 30000 });
    await page.waitForSelector(".status-group", { timeout: 15000 });
    // 本周拾光展开 + 等图表渲染
    await page.evaluate(() => {
      const vm = window.__tlHomeVM;
      vm.weeklyExpanded = true;
      vm.weeklyMode = "bars";
    });
    await page.waitForSelector(".week-chart .week-col", { timeout: 15000 });
    await sleep(500);

    // 01 首页总览（含统计卡 + 本周拾光 + 标签栏）
    await shot(page, "01-首页-项目总览.png");

    // 01b 本周拾光（柱状形态）
    const weekPanel = await page.locator(".week-panel").first().boundingBox();
    await shot(page, "01b-首页-本周拾光.png", {
      clip: { x: Math.max(0, weekPanel.x - 8), y: Math.max(0, weekPanel.y - 8),
              width: Math.min(1600, weekPanel.width + 16), height: weekPanel.height + 16 },
    });

    // 02 本周拾光热力图形态（替代旧「开发活动热力图」）
    await page.evaluate(() => window.__tlHomeVM.setWeeklyMode("heat"));
    await page.waitForSelector(".week-heat", { timeout: 5000 });
    await sleep(400);
    await shot(page, "02-首页-本周拾光热力图.png", {
      clip: { x: Math.max(0, weekPanel.x - 8), y: Math.max(0, weekPanel.y - 8),
              width: Math.min(1600, weekPanel.width + 16), height: weekPanel.height + 16 },
    });
    await page.evaluate(() => window.__tlHomeVM.setWeeklyMode("bars"));

    // 03 项目卡片
    await page.evaluate(() => {
      document.querySelector(".status-group").scrollIntoView({ behavior: "instant", block: "start" });
    });
    await sleep(300);
    await shot(page, "03-首页-项目卡片.png");

    // 04 暗色主题（同一首屏视角）
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await sleep(400);
    await shot(page, "04-首页-暗色主题.png");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await sleep(300);

    // 05 批量扫描导入（弹窗已填根目录）
    await page.locator("button", { hasText: "批量扫描导入" }).first().click();
    await page.waitForSelector("#scan-root", { timeout: 5000 });
    await page.fill("#scan-root", path.join(state.root, "samples"));
    await sleep(300);
    await shot(page, "05-批量扫描导入.png");

    // 05b 扫描结果（全部已导入）
    const scanBtn = page.locator(".modal button", { hasText: "开始扫描" }).first();
    await scanBtn.click();
    await page.waitForFunction(() => {
      const t = document.body.innerText;
      return t.includes("已导入");
    }, null, { timeout: 20000 });
    await sleep(400);
    await shot(page, "05b-扫描结果.png");
    await page.keyboard.press("Escape");
    await sleep(300);

    // 06 设置面板
    await page.locator("button[title='设置']").first().click();
    await page.waitForSelector(".modal", { timeout: 5000 });
    await sleep(400);
    await shot(page, "06-设置面板.png");
    await page.keyboard.press("Escape");
    await sleep(300);

    // ---------- 详情：demo-vue-admin ----------
    await page.goto(state.base + "/project/1");
    await page.waitForFunction(() => {
      const vm = window.__tlProjectVM;
      return vm && vm.p && vm.readme !== null && vm.launch !== null && vm.meta;
    }, null, { timeout: 30000 });
    await sleep(600);

    // 07 概览与 Git 信息
    await shot(page, "07-详情-概览与Git信息.png");

    // 08 快速启动与运行历史
    await page.evaluate(() => window.__tlProjectVM.switchTab("launch"));
    await page.waitForFunction(() => document.querySelector("#sec-runs .run-item, #sec-runs"),
      null, { timeout: 10000 });
    await sleep(600);
    await shot(page, "08-详情-快速启动与运行历史.png");

    // 10 提交记录与月度分布（展开月度图）
    await page.evaluate(() => window.__tlProjectVM.switchTab("records"));
    await page.waitForFunction(() => {
      const vm = window.__tlProjectVM;
      return vm.commitData && vm.commitData.commits && vm.commitData.commits.length > 0;
    }, null, { timeout: 20000 });
    const monthOpen = await page.evaluate(() => {
      const btn = document.querySelector("#sec-commits .heat-head");
      if (btn) { btn.click(); return true; }
      return false;
    });
    await sleep(700);
    await shot(page, "10-详情-提交记录与月度分布.png");

    // 11 提交构成分析
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("#sec-commits h3, #sec-commits h2")]
        .find(h => h.textContent.includes("提交构成分析"));
      if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
    });
    await sleep(400);
    await shot(page, "11-详情-提交构成分析.png");

    // 12 项目描述与开发笔记（展开个人记录）
    await page.evaluate(() => {
      const vm = window.__tlProjectVM;
      vm.openRecord();
      vm.openRecord("desc");
      vm.openRecord("notes");
      vm.openNoteDraft();
    });
    await sleep(700);
    await page.evaluate(() => {
      const el = document.getElementById("sec-personal");
      if (el) el.scrollIntoView({ behavior: "instant", block: "start" });
    });
    await sleep(300);
    await shot(page, "12-详情-项目描述与开发笔记.png");

    // 09 构建配置与文件统计（项目资料顶部）
    await page.evaluate(() => window.__tlProjectVM.switchTab("materials"));
    await page.waitForFunction(() => document.querySelector("#sec-configs"),
      null, { timeout: 10000 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await sleep(500);
    await shot(page, "09-详情-构建配置与文件统计.png");

    // 13 截图 / README / 目录树（README 目录联动态）
    await page.evaluate(() => window.__tlProjectVM.scrollTo("sec-readme"));
    await page.waitForFunction(() => window.__tlProjectVM.tocTitle === "README 目录",
      null, { timeout: 6000 });
    await page.waitForFunction(() => {
      const w = window.__tlProjectVM;
      return w.readmeHeadings.some(h => h.id === w.activeSection);
    }, null, { timeout: 6000 });
    await sleep(400);
    await shot(page, "13-详情-截图README目录树.png");

    // ---------- 详情：demo-fastapi-service ----------
    await page.goto(state.base + "/project/2");
    await page.waitForFunction(() => {
      const vm = window.__tlProjectVM;
      return vm && vm.p && vm.readme !== null && vm.meta;
    }, null, { timeout: 30000 });
    await sleep(600);
    await shot(page, "14-详情-后端项目总览.png");

    assert.deepEqual(errorsSnapshot(), [], "不应出现 console/page 错误");
    console.log("PASS 16 张截图已写入 " + OUT);
  } finally {
    await browser.close();
  }

  function chromium_launch() {
    // 延迟 require：脚本顶部保持单一职责
    const { chromium } = require("playwright");
    return chromium.launch({ channel: "chrome", headless: true });
  }
})().catch(e => { console.error("FAIL " + e.message); process.exit(1); });
