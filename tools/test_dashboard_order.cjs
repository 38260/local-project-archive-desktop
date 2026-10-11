// 首页排序逻辑回归：保留真正的 Vue 配置，仅替换浏览器与设置接口。
// 语义（T2 改版后）：状态分组永远保留；组内拖动直接保存；
// 没有独立「手动排序」模式，排序下拉是一键整理（会清掉拖动顺序）。
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
  window: { TL_HELPERS: {} },
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
    { id: 2, name: "Beta", status: "进行中", pinned: false, tags: [], updated_at: "2026-10-02" },
    { id: 3, name: "Gamma", status: "已完成", pinned: false, tags: [], updated_at: "2026-10-01" },
    { id: 4, name: "Pinned", status: "进行中", pinned: true, tags: [], updated_at: "2026-09-01" },
  ];
  return instance;
}
const ids = app => Array.from(app.sorted, p => p.id);
// displayGroups/items 是 vm 沙箱 realm 的数组，先转成宿主数组再比较
const groupStatuses = app => Array.from(app.displayGroups, g => g.status);
const groupIds = (app, i) => Array.from(app.displayGroups[i].items, p => p.id);

(async () => {
  // 1) 默认视图：置顶优先 + 状态分组（不再有「置顶项目 / 项目」的另一种视图）
  const app = page();
  assert.deepEqual(ids(app), [4, 1, 2, 3]);
  assert.deepEqual(groupStatuses(app), ["进行中", "已完成"]);
  assert.deepEqual(groupIds(app, 0), [4, 1, 2]);

  // 2) 组内拖动直接保存：不切排序模式、组标题与成员不变
  await app.moveProject(1, 2, true);
  assert.deepEqual(ids(app), [4, 2, 1, 3]);
  assert.equal(app.sortBy, "最近更新");
  assert.deepEqual(groupStatuses(app), ["进行中", "已完成"]);

  // 3) 跨状态、跨置顶边界、不存在项目的移动一律拒绝
  await app.moveProject(1, 3, true);      // 进行中 → 已完成
  await app.moveProject(4, 1, false);     // 置顶 → 非置顶
  await app.moveProject(999, 1, true);    // 目标不存在
  assert.deepEqual(ids(app), [4, 2, 1, 3]);

  // 4) 筛选视图里拖动：只动同状态项，隐藏项目保留在完整顺序中
  app.statusFilter = "进行中";
  assert.deepEqual(Array.from(app.filtered, p => p.id), [4, 2, 1]);
  await app.moveProject(2, 1, false);
  assert.deepEqual(Array.from(app.filtered, p => p.id), [4, 2, 1]);
  assert.equal(new Set(app.projectOrder).size, 4);   // 隐藏的 3 没有丢
  app.statusFilter = "";
  assert.deepEqual(ids(app), [4, 2, 1, 3]);

  // 5) 一键整理：选择规则清空拖动顺序并按规则重排；保存失败时回滚
  failSave = true;
  await app.saveSort("名称");
  assert.equal(app.sortBy, "最近更新");
  assert.deepEqual(Array.from(app.projectOrder), [4, 2, 1, 3]);
  failSave = false;
  await app.saveSort("名称");
  assert.equal(app.sortBy, "名称");
  assert.deepEqual(Array.from(app.projectOrder), []);
  assert.deepEqual(ids(app), [4, 1, 2, 3]);
  assert.deepEqual(groupStatuses(app), ["进行中", "已完成"]);

  // 6) 整理后仍可拖动覆盖；键盘移动在同状态组内生效
  await app.moveProject(2, 1, false);
  assert.deepEqual(ids(app), [4, 2, 1, 3]);
  await app.moveProjectByKey(app.projects[0], -1);   // 1 上移到 2 之前（同组）
  assert.deepEqual(ids(app), [4, 1, 2, 3]);
  await app.moveProjectByKey(app.projects[2], -1);   // 3 是已完成组唯一项：无邻居，不动
  assert.deepEqual(ids(app), [4, 1, 2, 3]);

  // 7) 保存失败回退：顺序与展示都恢复原样
  failSave = true;
  await app.moveProject(1, 2, false);
  assert.deepEqual(ids(app), [4, 1, 2, 3]);
  assert.equal(app.orderSaving, false);
  failSave = false;

  // 8) 新项目追加到对应状态组的末尾，不打乱已拖好的相对位置
  app.projects.push({ id: 5, name: "New", status: "进行中", tags: [], updated_at: "2026-10-04" });
  assert.deepEqual(groupIds(app, 0), [4, 1, 2, 5]);   // 进行中组：新项目在末尾
  assert.deepEqual(groupIds(app, 1), [3]);            // 已完成组不受影响

  // 9) 旧偏好升级：旧「手动排序」回退为默认规则，旧拖动顺序继续作用于各组
  stored = { "ui.project_order": [999, null, "1", 2], "ui.project_sort": "手动排序" };
  const reloaded = page();
  await reloaded.loadPrefs();
  assert.equal(reloaded.sortBy, "最近更新");
  assert.deepEqual(Array.from(reloaded.projectOrder), [999, 2]);
  assert.deepEqual(ids(reloaded), [4, 2, 1, 3]);
  assert.deepEqual(groupStatuses(reloaded), ["进行中", "已完成"]);

  console.log("PASS: 状态分组保留、组内拖动直接保存、跨组/置顶边界拒绝、筛选保留完整顺序、一键整理、键盘移动、失败回退、新项目追加与旧偏好升级");
})().catch(error => { console.error(error); process.exitCode = 1; });
