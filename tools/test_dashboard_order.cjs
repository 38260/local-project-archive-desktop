// 首页排序逻辑回归：保留真正的 Vue 配置，仅替换浏览器与设置接口。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let options;
let stored = {};
let failSave = false;
const context = {
  Vue: { createApp(config) {
    options = config;
    return { config: { globalProperties: {} }, component() {}, directive() {}, mount() {} };
  } },
  window: { LPA_HELPERS: {} },
  localStorage: { getItem() { return null; } },
  toast() {},
  api: async (url, request) => {
    assert.equal(url, "/api/settings");
    if (request?.method === "PUT") {
      if (failSave) throw new Error("保存失败");
      Object.assign(stored, JSON.parse(JSON.stringify(request.body)));
    }
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
  instance.projects = [
    { id: 1, name: "Alpha", status: "进行中", pinned: false, tags: [], updated_at: "2026-10-03" },
    { id: 2, name: "Beta", status: "已完成", pinned: false, tags: [], updated_at: "2026-10-02" },
    { id: 3, name: "Gamma", status: "暂停", pinned: false, tags: [], updated_at: "2026-10-01" },
    { id: 4, name: "Pinned", status: "已完成", pinned: true, tags: [], updated_at: "2026-09-01" },
  ];
  return instance;
}
const ids = app => Array.from(app.sorted, p => p.id);

(async () => {
  const app = page();
  assert.deepEqual(ids(app), [4, 1, 2, 3]);
  const grouped = page();
  grouped.projects.forEach(p => { p.pinned = false; });
  grouped.projects[2].updated_at = "2026-10-10";
  await grouped.moveProject(1, 2, true);
  assert.deepEqual(ids(grouped), [2, 1, 4, 3]);
  await app.moveProject(1, 3, true);
  assert.deepEqual(ids(app), [4, 2, 3, 1]);
  assert.equal(app.sortBy, "手动排序");
  assert.equal(app.displayGroups[0].status, "置顶项目");
  const reloaded = page();
  await reloaded.loadPrefs();
  assert.deepEqual(ids(reloaded), [4, 2, 3, 1]);
  app.statusFilter = "进行中";
  await app.moveProject(3, 2, false);
  assert.deepEqual(ids(app), [4, 3, 2, 1]);
  assert.equal(new Set(app.projectOrder).size, 4);
  await app.moveProject(4, 1, true);
  assert.deepEqual(ids(app), [4, 3, 2, 1]);
  await app.moveProject(999, 1, true);
  assert.deepEqual(ids(app), [4, 3, 2, 1]);
  app.statusFilter = "";
  await app.moveProjectByKey(app.projects[0], -1);
  assert.deepEqual(ids(app), [4, 3, 1, 2]);
  failSave = true;
  await app.moveProject(1, 3, false);
  assert.deepEqual(ids(app), [4, 3, 1, 2]);
  assert.equal(app.orderSaving, false);
  await app.saveSort("名称");
  assert.equal(app.sortBy, "手动排序");
  failSave = false;
  await app.saveSort("名称");
  assert.deepEqual(ids(app), [4, 1, 2, 3]);
  await app.saveSort("手动排序");
  assert.deepEqual(ids(app), [4, 3, 1, 2]);
  app.projects.push({ id: 5, name: "New", status: "进行中", tags: [], updated_at: "2026-10-04" });
  assert.deepEqual(ids(app), [4, 3, 1, 2, 5]);
  stored = { "ui.project_order": [999, null, "1", 2], "ui.project_sort": "invalid" };
  await reloaded.loadPrefs();
  assert.equal(reloaded.sortBy, "最近更新");
  assert.deepEqual(Array.from(reloaded.projectOrder), [999, 2]);
  console.log("PASS: 拖动顺序、刷新持久化、筛选保留、置顶边界、键盘移动、失败回退、切换排序、新项目和无效偏好");
})().catch(error => { console.error(error); process.exitCode = 1; });
