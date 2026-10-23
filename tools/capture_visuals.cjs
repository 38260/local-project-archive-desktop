// 视觉复核截图：与参考图接近的桌面视口，单屏（非长页缩略）截图。
// 用法：node tools/capture_visuals.cjs $TL_STATE [home|detail|all]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const mode = process.argv[3] || "home";
const root = fs.realpathSync(state.root);
const output = process.env.TL_VISUAL_DIR
  || path.join(process.cwd(), "docs", "evidence", "visual-alignment");
fs.mkdirSync(output, { recursive: true });

(async () => {
  const listing = await (await fetch(state.base + "/api/projects")).json();
  const project = listing.projects.find(p => p.name === "Tracelight") || listing.projects[0];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 }, reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  async function settle() {
    // 首次自动更新在挂载后几百毫秒才开始，先等它跑完，再截干净的静态首屏
    await page.waitForTimeout(3200);
    await page.waitForFunction(() => !document.querySelector(".toast")
      && !document.querySelector(".auto-refresh-strip"), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(200);
  }
  async function shot(file) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(output, file), fullPage: false });
  }
  try {
    if (mode === "home" || mode === "all") {
      await page.goto(state.base);
      await page.waitForFunction(() => window.__tlHomeVM && !window.__tlHomeVM.loading
        && document.querySelector(".home-sidebar"));
      await settle();
      await shot("home-1440x960.png");
      console.log("captured home-1440x960.png");
    }
    if (mode === "detail" || mode === "all") {
      await page.goto(`${state.base}/project/${project.id}`);
      await page.waitForFunction(() => window.__tlProjectVM && window.__tlProjectVM.p
        && window.__tlProjectVM.recentActivityLoading === false && window.__tlProjectVM.readme !== null);
      await settle();
      await shot("detail-1440x960.png");
      console.log("captured detail-1440x960.png");
      for (const [label, file] of [["启动与运行", "detail-launch-1440x960.png"],
                                   ["开发记录", "detail-records-1440x960.png"],
                                   ["项目资料", "detail-materials-1440x960.png"]]) {
        await page.locator(".tab-nav .tab-btn").filter({ hasText: label }).click();
        await page.waitForTimeout(200);
        await settle();
        await shot(file);
        console.log("captured " + file);
      }
    }
    if (errors.length) throw new Error(errors.join("\n"));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
