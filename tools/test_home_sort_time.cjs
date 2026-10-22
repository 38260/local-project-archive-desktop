// 首页 F2 回归：最近打开排序/视图、本地日历日相对时间、拖动保护。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let options;
let stored = {};
const context = {
  Vue: { createApp(config) {
    options = config;
    return { config: { globalProperties: {} }, component() {}, directive() {}, mount() {} };
  } },
  window: { TL_HELPERS: {}, scrollTo() {} },
  localStorage: { getItem() { return null; } },
  toast() {},
  fmtTime: (iso) => new Date(iso).toISOString(),
  api: async (url, request) => {
    if (request?.method === "PUT") Object.assign(stored, JSON.parse(JSON.stringify(request.body)));
    return stored;
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
  const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).toISOString();
  instance.projects = [
    { id: 1, name: "Alpha", status: "进行中", pinned: false, tags: [], updated_at: "2026-10-03",
      last_opened_at: at(2026, 10, 20, 10, 0) },
    { id: 2, name: "Beta", status: "进行中", pinned: false, tags: [], updated_at: "2026-10-02",
      last_opened_at: at(2026, 10, 19, 10, 0) },
    { id: 3, name: "Gamma", status: "已完成", pinned: false, tags: [], updated_at: "2026-10-01",
      last_opened_at: at(2026, 10, 21, 10, 0) },
    { id: 4, name: "Pinned", status: "进行中", pinned: true, tags: [], updated_at: "2026-09-01",
      last_opened_at: "" },
    { id: 5, name: "NoRecord", status: "已完成", pinned: false, tags: [], updated_at: "2026-09-02",
      last_opened_at: "not-a-time" },
    { id: 6, name: "Dropped", status: "废弃", pinned: false, tags: [], updated_at: "2026-09-03",
      last_opened_at: "" },
  ];
  return instance;
}

const ids = app => Array.from(app.sorted, p => p.id);

(async () => {
  const app = page();
  assert(app.sortOptions.includes("最近打开"), "排序下拉应包含最近打开");

  // 1) 最近打开排序：置顶优先，其余按访问时间倒序，空/无效记录在后且按 id 稳定
  app.sortBy = "最近打开";
  assert.deepEqual(ids(app), [4, 3, 1, 2, 5, 6]);

  // 2) 相同访问时间按 id 稳定兜底，空记录排在有记录之后
  app.projects[1].last_opened_at = app.projects[0].last_opened_at;
  assert.deepEqual(ids(app), [4, 3, 1, 2, 5, 6]);

  // 3) 最近打开视图：只含有记录项目，保留状态分组；手动顺序不得覆盖访问时间排序
  app.projectOrder = [2, 1, 3, 4, 5, 6];
  app.quickFilter = "recent";
  assert.deepEqual(Array.from(app.filtered, p => p.id), [3, 1, 2]);
  assert.deepEqual(Array.from(app.displayGroups, g => g.status), ["进行中", "已完成"]);
  assert.deepEqual(Array.from(app.displayGroups[0].items, p => p.id), [1, 2]);
  assert.equal(app.dragLocked, true);
  await app.moveProject(1, 2, true);
  assert.deepEqual(app.projectOrder, [2, 1, 3, 4, 5, 6], "最近打开视图不能改写手动顺序");
  await app.moveProjectByKey(app.projects[0], 1);
  assert.deepEqual(app.projectOrder, [2, 1, 3, 4, 5, 6]);

  // 4) 已置顶视图：只筛置顶，保留状态分组，不受访问记录限制
  app.quickFilter = "pinned";
  assert.deepEqual(Array.from(app.filtered, p => p.id), [4]);
  assert.deepEqual(Array.from(app.displayGroups, g => g.status), ["进行中"]);
  assert.equal(app.dragLocked, false);

  // 5) 显式点击“废弃”状态时能查看到，即使默认隐藏废弃项目
  app.quickFilter = null;
  app.showDiscarded = false;
  app.statusFilter = "废弃";
  assert.deepEqual(Array.from(app.filtered, p => p.id), [6]);
  app.statusFilter = "";
  // 退出临时视图后恢复“置顶 → 手动顺序”，仍不显示废弃项
  assert.deepEqual(Array.from(app.filtered, p => p.id), [4, 2, 1, 3, 5]);

  // 6) 相对日期按本地日历日：跨午夜不到 24 小时也算“昨天”
  const now = new Date(2026, 9, 22, 9, 0);
  const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).toISOString();
  assert.equal(app.openAgeInfo(at(2026, 10, 22, 0, 30), now.getTime()).text, "今天");
  assert.equal(app.openAgeInfo(at(2026, 10, 21, 23, 30), now.getTime()).text, "昨天");
  assert.equal(app.openAgeInfo(at(2026, 10, 15, 12, 0), now.getTime()).text, "7 天前");
  assert.equal(app.openAgeInfo("", now.getTime()).text, "尚无打开记录");
  assert.equal(app.openAgeInfo("bad", now.getTime()).text, "尚无打开记录");
  assert.equal(app.openAgeInfo(at(2026, 10, 23, 9, 0), now.getTime()).text, "刚刚");
  const midnight = new Date(2026, 9, 23, 0, 5);
  assert.equal(app.openAgeInfo(at(2026, 10, 22, 23, 55), midnight.getTime()).text, "昨天");
  assert(app.openAgeInfo(at(2026, 10, 22, 0, 30), now.getTime()).title.includes("上次打开："));

  // 7) 普通列表仍保留手动顺序（最近打开视图不改写它）
  app.quickFilter = null;
  app.sortBy = "最近更新";
  assert.deepEqual(ids(app), [4, 2, 1, 3, 5, 6]);

  console.log("PASS: F2 最近打开排序/视图、状态分组、拖动保护、废弃显式可见、本地日历日与无效时间兜底");
})().catch(error => { console.error(error); process.exitCode = 1; });
