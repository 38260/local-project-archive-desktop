// 首页 F5 回归：默认字母/缩写图标与稳定配色。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let options;
const context = {
  Vue: { createApp(config) {
    options = config;
    return { config: { globalProperties: {} }, component() {}, directive() {}, mount() {} };
  } },
  window: { TL_HELPERS: {}, scrollTo() {} },
  localStorage: { getItem() { return null; } },
  toast() {},
  fmtTime: (iso) => iso,
  api: async () => ({}),
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/static/js/dashboard.js"), "utf8"), context);

const instance = {};
for (const [key, method] of Object.entries(options.methods)) instance[key] = method.bind(instance);
Object.assign(instance, options.data.call(instance));
for (const [key, getter] of Object.entries(options.computed)) {
  Object.defineProperty(instance, key, { get: getter.bind(instance) });
}

// 驼峰 / 空格 / 连字符：取可读缩写
assert.equal(instance.projectInitials("WindowAnchor"), "WA");
assert.equal(instance.projectInitials("SkillManager"), "SM");
assert.equal(instance.projectInitials("select-project-alpha"), "SP");
assert.equal(instance.projectInitials("Tracelight"), "TR");
assert.equal(instance.projectInitials("SuKe"), "SK");
assert.equal(instance.projectInitials("归迹拾光"), "归迹");
assert.equal(instance.projectInitials(""), "?");
assert.equal(instance.projectInitials("   "), "?");
assert.equal(instance.projectInitials("C++"), "C");
assert.equal(instance.projectInitials("C#"), "C");
assert.equal(instance.projectInitials("Go"), "GO");

// 同一个项目 ID 颜色稳定；相邻项目使用参考图的蓝/绿/紫起点
assert.equal(instance.logoColor({ id: 1, name: "A" }), "#2F81F7");
assert.equal(instance.logoColor({ id: 2, name: "B" }), "#22A66A");
assert.equal(instance.logoColor({ id: 3, name: "C" }), "#9061F9");
assert.equal(instance.logoColor({ id: 1, name: "Renamed" }), "#2F81F7");
assert.equal(instance.logoColor({ id: 7 }), instance.logoColor({ id: 1 }));
assert.equal(instance.logoColor({}), "#2F81F7");

console.log("PASS: F5 字母/缩写生成、空名称兜底与按项目 ID 稳定配色");
