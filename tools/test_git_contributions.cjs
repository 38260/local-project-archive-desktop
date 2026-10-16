// 运行实际页面方法，验证作者切换和旧请求晚到时不会覆盖新口径。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function page(file) {
  let options;
  const pending = [];
  const stored = {};
  const sandbox = {
    Vue: { createApp(config) {
      options = config;
      return { config: { globalProperties: {} }, component() {}, directive() {}, mount() {} };
    } },
    window: { TL_HELPERS: {} }, location: { pathname: "/project/1" },
    localStorage: { getItem(k) { return stored[k] ?? null; }, setItem(k, v) { stored[k] = v; } },
    api: url => new Promise((resolve, reject) => pending.push({ url, resolve, reject })),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../app/static/js", file), "utf8"), sandbox);
  const instance = {};
  for (const [key, fn] of Object.entries(options.methods)) instance[key] = fn.bind(instance);
  Object.assign(instance, options.data.call(instance));
  return { instance, pending, stored };
}

(async () => {
  const { instance: detail, pending, stored } = page("project.js");
  assert.equal(detail.commitAuthors, "mine");
  const old = detail.reloadGit();
  assert(pending.every(p => p.url.includes("authors=mine")));
  detail.setCommitAuthors("all");
  assert.equal(stored["tl-commit-authors"], "all");
  assert(pending.slice(3).every(p => p.url.includes("authors=all")));
  pending.slice(3).forEach(p => p.resolve({ scope: "all" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(detail.commitData.scope, "all");
  pending.slice(0, 3).forEach(p => p.resolve({ scope: "mine" }));
  await old;
  assert.equal(detail.commitData.scope, "all");
  assert.equal(detail.commitStats.scope, "all");
  assert.equal(detail.heat.scope, "all");
  assert.equal(detail.commitLoading, false);
  assert.equal(detail.commitStatsLoading, false);
  const failed = detail.reloadGit();
  pending.slice(6).forEach(p => p.reject(new Error("offline")));
  await failed;
  assert.equal(detail.commitData, null);
  assert.equal(detail.commitStats, null);
  assert.equal(detail.commitLoading, false);
  const before = pending.length;
  const theme = detail.onSettingsChanged("prefs", "theme");
  pending[before].resolve({});
  await theme;
  assert.equal(pending.length, before + 1, "主题变化不重跑 Git 分析");
  const identity = detail.onSettingsChanged("prefs", "git.author_emails");
  pending[before + 1].resolve({});
  await identity;
  assert.equal(pending.length, before + 5, "身份变化同时刷新三个 Git 入口");
  pending.slice(before + 2).forEach(p => p.resolve({ scope: "all" }));
  await new Promise(resolve => setImmediate(resolve));

  const { instance: home, pending: requests } = page("dashboard.js");
  const first = home.loadHeatmap();
  const second = home.loadHeatmap();
  requests[1].resolve({ total: 2 });
  await second;
  requests[0].resolve({ total: 99 });
  await first;
  assert.equal(home.heat.total, 2);
  home.openDayDetail({ date: "2026-10-16", n: 1 });
  home.closeDay();
  requests[2].resolve({ total: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(home.showDay, false);
  assert.equal(home.dayData, null);
  console.log("PASS: 三入口作者切换、旧响应隔离、失败降级、首页刷新竞态与关闭明细");
})().catch(error => { console.error(error); process.exitCode = 1; });
