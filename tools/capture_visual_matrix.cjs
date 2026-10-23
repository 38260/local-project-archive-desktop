// V5 视觉矩阵：首页 + 详情概览在 1920/1440/1024/768/390 的亮暗截图，
// 以及 1440 下详情其余三个分区的亮暗截图。只接受隔离实例的 state.json。
// 用法：node tools/capture_visual_matrix.cjs <state.json>
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const output = process.env.TL_VISUAL_DIR
  || path.join(process.cwd(), "docs", "evidence", "visual-alignment", "v5");
fs.mkdirSync(output, { recursive: true });

const CASES = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 1024 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];
const THEMES = ["light", "dark"];
const SECTIONS = [
  ["启动与运行", "launch"],
  ["开发记录", "records"],
  ["项目资料", "materials"],
];

(async () => {
  const listing = await (await fetch(state.base + "/api/projects")).json();
  const project = listing.projects.find(p => p.name === "Tracelight") || listing.projects[0];
  if (!project) throw new Error("没有可用于截图的项目");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const report = { fixture: state.root, project: project.name, cases: [], errors: [] };

  async function settle(page) {
    await page.waitForTimeout(2600);
    await page.waitForFunction(() => !document.querySelector(".toast")
      && !document.querySelector(".auto-refresh-strip"), null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(150);
  }
  async function shot(page, file) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(output, file), fullPage: false });
  }
  async function metrics(page) {
    return page.evaluate(() => {
      const de = document.documentElement;
      const over = [...document.querySelectorAll("body *")]
        .filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && (r.right > innerWidth + 2 || r.left < -2);
        })
        .slice(0, 6)
        .map(el => `${el.tagName.toLowerCase()}.${String(el.className || "").split(/\s+/)[0]}`);
      return {
        innerWidth: innerWidth,
        scrollWidth: de.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        horizontalOverflow: de.scrollWidth > innerWidth + 1,
        offscreen: over,
      };
    });
  }
  const homeReady = page => page.waitForFunction(() =>
    window.__tlHomeVM && !window.__tlHomeVM.loading && document.querySelector(".home-sidebar"),
  null, { timeout: 30000 });
  const detailReady = page => page.waitForFunction(() => {
    const vm = window.__tlProjectVM;
    return vm && vm.p && vm.launch !== null && vm.readme !== null
      && vm.recentActivityLoading === false && vm.recentCommitsLoading === false;
  }, null, { timeout: 30000 });

  try {
    for (const theme of THEMES) {
      for (const { width, height } of CASES) {
        const context = await browser.newContext({
          viewport: { width, height }, colorScheme: theme, reducedMotion: "reduce",
        });
        await context.addInitScript(t => localStorage.setItem("tl-theme", t), theme);
        const page = await context.newPage();
        const pageErrors = [];
        page.on("pageerror", e => pageErrors.push(e.message));
        const row = { theme, width, height, home: {}, detail: {}, sections: {} };

        await page.goto(state.base);
        await homeReady(page);
        await settle(page);
        row.home.file = `home-${width}-${theme}.png`;
        await shot(page, row.home.file);
        row.home.metrics = await metrics(page);

        await page.goto(`${state.base}/project/${project.id}`);
        await detailReady(page);
        await settle(page);
        row.detail.file = `detail-overview-${width}-${theme}.png`;
        await shot(page, row.detail.file);
        row.detail.metrics = await metrics(page);

        if (width === 1440) {
          for (const [label, key] of SECTIONS) {
            await page.locator(".tab-nav .tab-btn").filter({ hasText: label }).click();
            await page.waitForTimeout(250);
            await settle(page);
            row.sections[key] = { file: `detail-${key}-${width}-${theme}.png` };
            await shot(page, row.sections[key].file);
            row.sections[key].metrics = await metrics(page);
          }
        }

        const actualTheme = await page.evaluate(() =>
          document.documentElement.getAttribute("data-theme"));
        row.actualTheme = actualTheme;
        if (actualTheme !== theme) report.errors.push(`${width}/${theme}: 主题未生效（${actualTheme}）`);
        if (pageErrors.length) report.errors.push(`${width}/${theme}: ${pageErrors.join(" | ")}`);
        const overflow = [row.home, row.detail, ...Object.values(row.sections)]
          .filter(Boolean).some(x => x.metrics && x.metrics.horizontalOverflow);
        row.horizontalOverflow = overflow;
        if (overflow) report.errors.push(`${width}/${theme}: 存在横向溢出`);
        report.cases.push(row);
        console.log(`[shot] ${theme} ${width}x${height} home/detail${width === 1440 ? "+3 sections" : ""}`);
        await context.close();
      }
    }
    fs.writeFileSync(path.join(output, "report.json"),
      JSON.stringify(report, null, 2), "utf8");
    console.log(`[done] ${report.cases.length} 个视口组合，错误 ${report.errors.length} 条`);
    if (report.errors.length) throw new Error(report.errors.join("\n"));
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
