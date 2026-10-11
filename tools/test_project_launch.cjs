// 运行实际详情页逻辑，仅替换 Vue 挂载和外部 API。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let options;
const requests = [];
const messages = [];
let failSave = false;
let failCreate = false;
let savedLaunch;
let delaySave;
const context = {
  Vue: { createApp(config) {
    options = config;
    return { config: { globalProperties: {} }, component() {}, directive() {}, mount() {} };
  } },
  window: { TL_HELPERS: {} },
  location: { pathname: "/project/1" },
  localStorage: { getItem() { return null; } },
  toast(message, type) { messages.push({ message, type }); },
  api: async (url, request) => {
    const body = request?.body ? JSON.parse(JSON.stringify(request.body)) : null;
    requests.push({ url, body });
    if (url.endsWith("/launch-prefs")) {
      if (failSave) throw new Error("保存失败");
      if (delaySave) return delaySave(body);
      return body;
    }
    if (url.endsWith("/launchers") && request?.method === "POST") {
      if (failCreate) throw new Error("创建失败");
      return { id: 3, ...body };
    }
    assert.equal(url, "/api/projects/1/launch");
    return JSON.parse(JSON.stringify(savedLaunch));
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
    const created = { id: 3, name: "edited", command: "echo edited", cwd: "", mode: "console" };
    savedLaunch = { ...app.launch, launchers: [created], order: ["s:console||echo dev", "l:3"],
      primary: primary ? "l:3" : null, hidden: ["s:console||echo start"] };
    app.openLaunchForm(null, source);
    app.launchForm.name = "edited";
    app.launchForm.command = "echo edited";
    await app.saveLaunchForm();
    const posted = requests.filter(r => r.url.endsWith("/launchers")).at(-1).body;
    assert.deepEqual(posted.override_prefs.order, ["s:console||echo dev", "s:console||echo start"]);
    assert.equal(posted.override_prefs.primary, primary);
    assert.deepEqual(Array.from(app.orderedEntries, x => x.key), ["s:console||echo dev", "l:3"]);
    assert.equal(app.primaryLaunchEntry.name, primary ? "edited" : "dev");
    assert.deepEqual(Array.from(app.launchHidden), ["s:console||echo start"]);
  }
  const app = page();
  app.launch.launchers.push({ id: 9, name: "existing", command: "echo existing", cwd: "", mode: "console" });
  savedLaunch = { ...app.launch, launchers: [...app.launch.launchers,
    { id: 3, name: "edited", command: "echo edited", cwd: "", mode: "console" }],
    order: ["l:9", "s:console||echo dev", "l:3"], primary: null, hidden: ["s:console||echo start"] };
  app.openLaunchForm(null, app.launch.suggestions[1]);
  await app.saveLaunchForm();
  assert.deepEqual(Array.from(app.orderedEntries, x => x.key), ["l:9", "s:console||echo dev", "l:3"]);
  assert.equal(app.primaryLaunchEntry.name, "existing");
  const failed = page();
  const first = failed.launch.suggestions[0];
  const firstKey = failed.entryKey(first);
  failed.launch.primary = firstKey;
  failed.launchPrimary = firstKey;
  failSave = true;
  messages.length = 0;
  await failed.removeSuggestion(first);
  assert.deepEqual(Array.from(failed.launchHidden), []);
  assert.equal(failed.launchPrimary, firstKey);
  assert.equal(failed.visibleSuggestions.length, 2);
  assert.equal(messages.filter(m => m.type === "ok").length, 0);
  failed.launch.hidden = [firstKey];
  failed.launchHidden = [firstKey];
  await failed.restoreSuggestion(first);
  assert.deepEqual(Array.from(failed.launchHidden), [firstKey]);
  await failed.setPrimaryEntry(failed.launch.suggestions[1]);
  assert.equal(failed.launchPrimary, firstKey);
  assert.equal(failed.launchPrefsSaving, false);
  failSave = false;

  const pending = page();
  let resolveSave;
  delaySave = body => new Promise(resolve => { resolveSave = () => resolve(body); });
  const saving = pending.removeSuggestion(pending.launch.suggestions[0]);
  assert.equal(pending.launchPrefsSaving, true);
  await pending.removeSuggestion(pending.launch.suggestions[1]);
  assert.deepEqual(Array.from(pending.launchHidden), [firstKey]);
  resolveSave();
  await saving;
  delaySave = null;
  assert.equal(pending.launchPrefsSaving, false);

  const creation = page();
  creation.openLaunchForm(null, creation.launch.suggestions[1]);
  failCreate = true;
  messages.length = 0;
  await creation.saveLaunchForm();
  assert.equal(creation.showLaunchForm, true);
  assert.equal(creation.launch.launchers.length, 0);
  assert.deepEqual(Array.from(creation.launchHidden), []);
  assert.equal(messages.filter(m => m.type === "ok").length, 0);
  assert.equal(creation.launchFormSaving, false);
  console.log("PASS: 自动项覆盖位置与默认项、移除/恢复/默认项保存失败回退、并发保护、创建失败不部分覆盖");
})().catch(error => { console.error(error); process.exitCode = 1; });
