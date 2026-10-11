// 运行实际详情页逻辑，仅替换 Vue 挂载和外部 API。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let options;
const requests = [];
const context = {
  Vue: { createApp(config) {
    options = config;
    return { config: { globalProperties: {} }, component() {}, directive() {}, mount() {} };
  } },
  window: { TL_HELPERS: {} },
  location: { pathname: "/project/1" },
  localStorage: { getItem() { return null; } },
  toast() {},
  api: async (url, request) => {
    assert.equal(url, "/api/projects/1/launch-prefs");
    const saved = JSON.parse(JSON.stringify(request.body));
    requests.push(saved);
    return saved;
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/static/js/project.js"), "utf8"), context);

function page() {
  const instance = {};
  for (const [key, method] of Object.entries(options.methods)) instance[key] = method.bind(instance);
  Object.assign(instance, options.data.call(instance));
  for (const [key, getter] of Object.entries(options.computed)) {
    Object.defineProperty(instance, key, { get: getter.bind(instance) });
  }
  instance.launch = {
    supported: true, launchers: [], order: [], primary: null, hidden: [],
    suggestions: [
      { name: "dev", command: "echo dev", cwd: "", mode: "console" },
      { name: "start", command: "echo start", cwd: "", mode: "console" },
    ],
  };
  return instance;
}

(async () => {
  for (const primary of [null, "s:console||echo start"]) {
    const app = page();
    const source = app.launch.suggestions[1];
    app.launchPrimary = primary;
    await app.applyAutoOverride(app.entryKey(source), 3);
    app.launch.launchers.push({ id: 3, name: "edited", command: "echo edited", cwd: "", mode: "console" });
    assert.deepEqual(Array.from(app.orderedEntries, x => x.key), ["s:console||echo dev", "l:3"]);
    assert.equal(app.primaryLaunchEntry.name, primary ? "edited" : "dev");
    assert.deepEqual(Array.from(app.launchHidden), ["s:console||echo start"]);
  }
  const app = page();
  app.launch.launchers.push({ id: 9, name: "existing", command: "echo existing", cwd: "", mode: "console" });
  await app.applyAutoOverride(app.entryKey(app.launch.suggestions[1]), 3);
  app.launch.launchers.push({ id: 3, name: "edited", command: "echo edited", cwd: "", mode: "console" });
  assert.deepEqual(Array.from(app.orderedEntries, x => x.key), ["l:9", "s:console||echo dev", "l:3"]);
  assert.equal(app.primaryLaunchEntry.name, "existing");
  assert.equal(requests.length, 3);
  console.log("PASS: 自动项覆盖保留自然顺序、显式默认项和已有自定义项位置");
})().catch(error => { console.error(error); process.exitCode = 1; });
