// 首页 F3 回归：状态/标签/快捷视图交叉筛选、候选计数、导航配置持久化。
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
    assert.equal(url, "/api/settings");
    if (request?.method === "PUT") {
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
  const at = (d, h) => new Date(2026, 9, d, h, 0).toISOString();
  instance.projects = [
    { id: 1, name: "Alpha", status: "进行中", pinned: false, tags: ["Python", "Vue"],
      category: "Web", updated_at: "2026-10-03", last_opened_at: at(22, 9) },
    { id: 2, name: "Beta", status: "进行中", pinned: true, tags: ["Python"],
      category: "Web", updated_at: "2026-10-02", last_opened_at: "" },
    { id: 3, name: "Gamma", status: "已完成", pinned: false, tags: ["Vue"],
      category: "Tool", updated_at: "2026-10-01", last_opened_at: "" },
    { id: 4, name: "Delta", status: "暂停", pinned: false, tags: [],
      category: "Tool", updated_at: "2026-09-30", last_opened_at: at(21, 9) },
    { id: 5, name: "Epsilon", status: "归档", pinned: false, tags: ["Python"],
      category: "Web", updated_at: "2026-09-29", last_opened_at: "" },
    { id: 6, name: "Zeta", status: "废弃", pinned: false, tags: ["Python"],
      category: "Web", updated_at: "2026-09-28", last_opened_at: "" },
    { id: 7, name: "Eta", status: "进行中", pinned: false, tags: ["Rust"],
      category: "Lab", updated_at: "2026-09-27", last_opened_at: at(15, 9) },
  ];
  instance.navTags = ["Python", "Vue", "Rust"];
  return instance;
}

function resetFilters(app) {
  app.q = "";
  app.statusFilter = "";
  app.tagFilter = "";
  app.catFilter = "";
  app.quickFilter = null;
  app.showDiscarded = false;
}

(async () => {
  const app = page();
  resetFilters(app);

  // 1) 默认视图：导航数字 = 点击后的列表数量
  const counts = { ...app.navCounts };
  assert.deepEqual(counts, { all: 6, recent: 3, pinned: 1 });
  assert.equal(app.filtered.length, counts.all);
  app.quickFilter = "recent";
  assert.equal(app.filtered.length, counts.recent);
  app.quickFilter = "pinned";
  assert.equal(app.filtered.length, counts.pinned);
  app.quickFilter = null;

  // 2) 每个状态候选计数等于切换到该状态后的结果（废弃显式可见）
  const statusItems = Array.from(app.navStatusItems);
  assert.deepEqual(statusItems.map(x => x.status), ["进行中", "暂停", "已完成", "归档", "废弃"]);
  assert.deepEqual(statusItems.map(x => x.count), [3, 1, 1, 1, 1]);
  for (const item of statusItems) {
    app.statusFilter = item.status;
    assert.equal(app.filtered.length, item.count, `状态 ${item.status} 计数一致`);
  }
  app.statusFilter = "";
  assert.equal(app.filtered.some(p => p.id === 6), false, "默认隐藏废弃");
  app.statusFilter = "废弃";
  assert.deepEqual(Array.from(app.filtered, p => p.id), [6], "显式点击废弃可见");
  app.statusFilter = "";

  // 3) 标签候选计数：排除当前标签选择、保留状态条件；标签可重叠，不要求求和等于总数
  const tagItems = Array.from(app.navTagItems);
  assert.deepEqual(tagItems.map(x => [x.tag, x.count]), [["Python", 3], ["Vue", 2], ["Rust", 1]]);
  for (const item of tagItems) {
    app.tagFilter = item.tag;
    assert.equal(app.filtered.length, item.count, `标签 ${item.tag} 计数一致`);
  }
  app.statusFilter = "进行中";
  app.tagFilter = "";
  const statusWithTag = Array.from(app.navStatusItems);
  assert.equal(statusWithTag.find(x => x.status === "进行中").count, 3);
  app.tagFilter = "Python";
  assert.deepEqual(Array.from(app.filtered, p => p.id), [2, 1]);
  assert.equal(app.navStatusItems.find(x => x.status === "已完成").count, 0);
  assert.equal(app.navStatusItems.find(x => x.status === "废弃").count, 1);
  app.statusFilter = "";
  app.tagFilter = "";

  // 4) 搜索/分类与状态、标签、快捷视图可叠加，计数随之更新
  app.q = "alpha";
  assert.equal(app.filtered.length, 1);
  assert.equal(app.navCounts.all, 1);
  assert.equal(app.navStatusItems.find(x => x.status === "进行中").count, 1);
  app.q = "";
  app.catFilter = "Web";
  assert.equal(app.navCounts.all, 3);
  assert.deepEqual(Array.from(app.filtered, p => p.id).sort((a, b) => a - b), [1, 2, 5]);
  app.catFilter = "";
  app.statusFilter = "进行中";
  app.tagFilter = "Python";
  app.quickFilter = "recent";
  assert.deepEqual(Array.from(app.filtered, p => p.id), [1]);
  resetFilters(app);

  // 5) 同区域再次点击当前条件可取消
  app.toggleStatus("进行中");
  assert.equal(app.statusFilter, "进行中");
  app.toggleStatus("进行中");
  assert.equal(app.statusFilter, "");
  app.toggleTag("Vue");
  assert.equal(app.tagFilter, "Vue");
  app.toggleTag("Vue");
  assert.equal(app.tagFilter, "");

  // 6) 旧设置缺键 → 默认；非法内容 → 回退；空数组 → 用户主动隐藏
  stored = {};
  const defaults = page();
  await defaults.loadPrefs();
  assert.deepEqual(Array.from(defaults.navSections), ["quick", "status", "tags"]);
  assert.deepEqual(Array.from(defaults.navStatuses), ["进行中", "暂停", "已完成", "归档", "废弃"]);
  assert.deepEqual(Array.from(defaults.navTags), []);

  stored = {
    "ui.nav_sections": ["tags", "quick", "bad", "tags"],
    "ui.nav_statuses": ["废弃", "进行中", "bad"],
    "ui.nav_tags": ["Vue", "  ", "Vue", 3, "  Rust  "],
  };
  const custom = page();
  await custom.loadPrefs();
  assert.deepEqual(Array.from(custom.navSections), ["tags", "quick"]);
  assert.deepEqual(Array.from(custom.navStatuses), ["废弃", "进行中"]);
  assert.deepEqual(Array.from(custom.navTags), ["Vue", "Rust"]);

  stored = { "ui.nav_sections": ["bad"], "ui.nav_statuses": ["bad"], "ui.nav_tags": "x" };
  const broken = page();
  await broken.loadPrefs();
  assert.deepEqual(Array.from(broken.navSections), ["quick", "status", "tags"]);
  assert.deepEqual(Array.from(broken.navStatuses), ["进行中", "暂停", "已完成", "归档", "废弃"]);
  assert.deepEqual(Array.from(broken.navTags), []);

  stored = { "ui.nav_sections": [], "ui.nav_statuses": [], "ui.nav_tags": [] };
  const hidden = page();
  await hidden.loadPrefs();
  assert.deepEqual(Array.from(hidden.navSections), []);
  assert.deepEqual(Array.from(hidden.navStatuses), []);
  assert.deepEqual(Array.from(hidden.navTags), []);

  // 7) 管理导航：模板、增删、排序、保存后立即生效并保留重启值
  stored = { "ui.nav_tags": ["Python", "Vue"] };
  const cfg = page();
  await cfg.loadPrefs();
  cfg.openNavConfig();
  assert.deepEqual(Array.from(cfg.navDraft.sections), ["quick", "status", "tags"]);
  cfg.applyNavTemplate("tags");
  assert.deepEqual(Array.from(cfg.navDraft.sections), ["quick", "tags"]);
  cfg.addDraftItem("sections", "status");
  cfg.moveDraftItem("sections", "status", -1);
  assert.deepEqual(Array.from(cfg.navDraft.sections), ["quick", "status", "tags"]);
  cfg.removeDraftItem("sections", "quick");
  cfg.addDraftItem("statuses", "已完成");
  cfg.moveDraftItem("statuses", "已完成", -1);
  assert.equal(cfg.navDraft.statuses[0], "进行中");
  cfg.addDraftItem("tags", "Rust");
  cfg.addDraftItem("tags", "Rust");
  assert.equal(cfg.navDraft.tags.filter(t => t === "Rust").length, 1);
  cfg.moveDraftItem("tags", "Rust", -1);
  cfg.moveDraftItem("tags", "Rust", -1);
  assert.deepEqual(Array.from(cfg.navDraft.tags), ["Rust", "Python", "Vue"]);
  await cfg.saveNavConfig();
  assert.equal(cfg.showNavConfig, false);
  assert.deepEqual(Array.from(cfg.navSections), ["status", "tags"]);
  assert.deepEqual(Array.from(cfg.navStatuses), ["进行中", "已完成", "暂停", "归档", "废弃"]);
  assert.deepEqual(Array.from(cfg.navTags), ["Rust", "Python", "Vue"]);
  assert.deepEqual(stored, {
    "ui.nav_sections": ["status", "tags"],
    "ui.nav_statuses": ["进行中", "已完成", "暂停", "归档", "废弃"],
    "ui.nav_tags": ["Rust", "Python", "Vue"],
  });
  const restart = page();
  await restart.loadPrefs();
  assert.deepEqual(Array.from(restart.navSections), ["status", "tags"]);
  assert.deepEqual(Array.from(restart.navStatuses), ["进行中", "已完成", "暂停", "归档", "废弃"]);
  assert.deepEqual(Array.from(restart.navTags), ["Rust", "Python", "Vue"]);

  console.log("PASS: F3 快捷/状态/标签交叉筛选、候选计数一致、废弃显式可见、导航配置增删排序与持久化");
})().catch(error => { console.error(error); process.exitCode = 1; });
