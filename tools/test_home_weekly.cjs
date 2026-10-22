// 首页 F4 回归：Top3 + 其他归并、稳定配色、每日守恒、加载/失败、日明细本地时区。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BLUE = "#2F81F7", GREEN = "#22A66A", PURPLE = "#9061F9", GRAY = "#A0A9B8";
let options;
let weeklyResponse;
let dayResponse;
let failWeekly = false;
const calls = [];
const localStore = {};
const context = {
  Vue: { createApp(config) {
    options = config;
    return { config: { globalProperties: {} }, component() {}, directive() {}, mount() {} };
  } },
  window: { TL_HELPERS: {}, scrollTo() {}, tlNavigate() {} },
  localStorage: {
    getItem(key) { return localStore[key] ?? null; },
    setItem(key, value) { localStore[key] = value; },
  },
  toast() {},
  fmtTime: (iso) => new Date(iso).toISOString(),
  api: async (url) => {
    calls.push(url);
    if (url === "/api/weekly") {
      if (failWeekly) throw new Error("服务不可用");
      return weeklyResponse;
    }
    if (url.startsWith("/api/day-commits")) return dayResponse;
    if (url === "/api/settings") return {};
    return {};
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/static/js/dashboard.js"), "utf8"), context);

function page() {
  const instance = {};
  for (const [key, method] of Object.entries(options.methods)) instance[key] = method.bind(instance);
  Object.assign(instance, options.data.call(instance));
  for (const [key, getter] of Object.entries(options.computed)) {
    Object.defineProperty(instance, key, { get: getter.bind(instance) });
  }
  instance.projects = [
    { id: 1, name: "A", status: "进行中", pinned: false, tags: [] },
    { id: 2, name: "B", status: "进行中", pinned: false, tags: [] },
    { id: 3, name: "C", status: "进行中", pinned: false, tags: [] },
    { id: 4, name: "D", status: "进行中", pinned: false, tags: [] },
  ];
  return instance;
}

weeklyResponse = {
  total: 11,
  project_count: 4,
  active_days: 3,
  start: "2026-10-16",
  end: "2026-10-22",
  repos: 4,
  failed_repos: 1,
  identity_required: false,
  // 输入顺序故意打乱，前端必须按 count 倒序 + id 稳定排序后分配颜色
  projects: [
    { id: 3, name: "C", count: 2 },
    { id: 4, name: "D", count: 1 },
    { id: 2, name: "B", count: 3 },
    { id: 1, name: "A", count: 5 },
  ],
  days: [
    { date: "2026-10-19", weekday: "周一", total: 0, projects: [] },
    { date: "2026-10-20", weekday: "周二", total: 6, projects: [
      { id: 1, name: "A", count: 3 }, { id: 2, name: "B", count: 2 },
      { id: 4, name: "D", count: 1 },
    ] },
    { date: "2026-10-21", weekday: "周三", total: 3, projects: [
      { id: 1, name: "A", count: 1 }, { id: 3, name: "C", count: 2 },
    ] },
    { date: "2026-10-22", weekday: "周四", total: 2, projects: [
      { id: 1, name: "A", count: 1 }, { id: 2, name: "B", count: 1 },
    ] },
    { date: "2026-10-23", weekday: "周五", total: 0, projects: [] },
    { date: "2026-10-24", weekday: "周六", total: 0, projects: [] },
    { date: "2026-10-25", weekday: "周日", total: 0, projects: [] },
  ],
  commits_by_day: [
    { date: "2026-10-22", weekday: "周四", total: 2, commits: [
      { hash: "h22", short: "h22", date: "2026-10-22T10:00:00+08:00", message: "feat: a",
        project_id: 1, project_name: "A", projects: [{ id: 1, name: "A" }] },
    ] },
  ],
};
dayResponse = {
  date: "2026-10-20", total: 6, project_count: 3,
  projects: [], failed_repos: 0, identity_required: false,
};

(async () => {
  const app = page();
  app.weekly = weeklyResponse;
  const view = app.weeklyView;
  assert.equal(view.total, 11);
  assert.equal(view.projectCount, 4);
  assert.equal(view.activeDays, 3);
  assert.equal(view.rangeLabel, "10/16～10/22");

  // 1) Top3 按数量稳定排序，颜色固定；第 4 个项目并入“其他”
  assert.deepEqual(Array.from(view.top, p => p.id), [1, 2, 3]);
  assert.deepEqual(Array.from(view.top, p => p.color), [BLUE, GREEN, PURPLE]);
  assert.equal(view.otherProjectCount, 1);
  assert.equal(view.otherTotal, 1);
  assert.equal(app.weekColorFor(1), BLUE);
  assert.equal(app.weekColorFor(2), GREEN);
  assert.equal(app.weekColorFor(3), PURPLE);
  assert.equal(app.weekColorFor(4), GRAY);
  assert.equal(app.weekColorFor(999), GRAY);

  // 2) 每日堆叠色块与右侧同一项目同色；“其他”与右侧归并集合一致
  const day20 = view.days.find(d => d.date === "2026-10-20");
  assert.deepEqual(Array.from(day20.segments, s => [s.key, s.count, s.color]), [
    ["p1", 3, BLUE], ["p2", 2, GREEN], ["other", 1, GRAY],
  ]);
  assert.equal(day20.segments.reduce((sum, s) => sum + s.count, 0), day20.total);
  assert.equal(day20.tipItems.find(x => x.name === "其他 1 个项目").count, 1);
  for (const day of view.days) {
    assert.equal(day.segments.reduce((sum, s) => sum + s.count, 0), day.total);
    for (const seg of day.segments) {
      if (!seg.other) assert.equal(seg.color, app.weekColorFor(Number(seg.key.slice(1))));
    }
    assert(day.segments.every(s => s.segPct >= 0 && s.segPct <= 100));
  }
  assert.equal(view.days.reduce((sum, d) => sum + d.total, 0), view.total);
  assert.equal(view.top.reduce((sum, p) => sum + p.count, 0) + view.otherTotal, view.total);
  assert(view.days.find(d => d.date === "2026-10-21").segments.every(s => s.color !== GRAY));

  // 3) 空数据/失败状态真实区分
  app.weekly = { ...weeklyResponse, total: 0, project_count: 0, active_days: 0,
                 projects: [], days: weeklyResponse.days.map(d => ({ ...d, total: 0, projects: [] })),
                 commits_by_day: [] };
  assert.equal(app.weeklyView.total, 0);
  assert.equal(app.weeklyView.top.length, 0);
  assert.equal(app.weeklyView.otherTotal, 0);
  app.weekly = null;
  failWeekly = true;
  await app.loadWeekly();
  assert.equal(app.weekly, null);
  assert.equal(app.weeklyError, "服务不可用");
  assert.equal(app.weeklyLoading, false);
  failWeekly = false;
  await app.loadWeekly();
  assert.equal(app.weeklyError, "");
  assert.equal(app.weekly.total, 11);
  assert.equal(app.weeklyLoading, false);

  // 4) 点击日期复用当日明细，显式使用本地时区口径
  calls.length = 0;
  app.openDayDetail("2026-10-20");
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(calls, ["/api/day-commits?date=2026-10-20&tz=local"]);
  assert.equal(app.showDay, true);
  assert.equal(app.dayData.total, 6);
  app.closeDay();
  assert.equal(app.showDay, false);

  // 5) 有提交才能打开总明细；折叠偏好写入独立键
  app.weekly = weeklyResponse;
  app.openWeeklyDetail();
  assert.equal(app.showWeeklyDetail, true);
  app.closeWeeklyDetail();
  assert.equal(app.showWeeklyDetail, false);
  const before = app.weeklyExpanded;
  app.toggleWeekly();
  assert.equal(app.weeklyExpanded, !before);
  assert.equal(localStore["tl-home-weekly-expanded"], app.weeklyExpanded ? "1" : "0");

  console.log("PASS: F4 Top3+其他归并、稳定配色、每日守恒、失败/空状态、本地时区明细与折叠记忆");
})().catch(error => { console.error(error); process.exitCode = 1; });
