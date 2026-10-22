/** R2 详情页自动更新验证（CDP）。用法：node verify-autorefresh-detail.mjs plan.json */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { port, debugPort, outDir, chrome, a, b, path_a, path_b } = plan;
const BASE = `http://127.0.0.1:${port}`;
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); fails.push(msg); }
}

class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error: ' + (e.message || 'unknown'))); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => c._onMsg(ev.data);
    return c;
  }
  _onMsg(data) {
    const msg = JSON.parse(data);
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) rej(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
      else res(msg.result);
      return;
    }
    if (msg.method) for (const l of [...this.listeners]) l(msg);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 90000);
    });
  }
  once(method, timeout = 30000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.listeners = this.listeners.filter((x) => x !== fn); rej(new Error('等待超时: ' + method)); }, timeout);
      const fn = (m) => { if (m.method === method) { clearTimeout(t); this.listeners = this.listeners.filter((x) => x !== fn); res(m.params); } };
      this.listeners.push(fn);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
    return r.result.value;
  }
  async waitFor(expr, timeout = 40000, label = '') {
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < timeout) {
      try { if (await this.eval(`return !!(${expr});`)) return true; } catch (e) { last = e.message; }
      await sleep(200);
    }
    throw new Error(`等待超时: ${label || expr} ${last}`);
  }
}

const profile = mkdtempSync(path.join(tmpdir(), 'lpa-ar-'));
const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--no-pings', '--no-proxy-server',
  '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1440,1000',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeLog = '';
proc.stderr.on('data', (d) => { chromeLog += d.toString(); });

let cdp = null;
let refreshPosts = 0;

const VM = `window.__tlProjectVM`;

async function goto(url) {
  const loaded = cdp.once('Page.loadEventFired', 40000).catch(() => {});
  await cdp.send('Page.navigate', { url });
  await loaded;
}

async function settle() {
  await cdp.waitFor(`${VM} && ${VM}.p`, 30000, 'Vue 挂载 + 项目加载');
  await sleep(500);
}

async function waitRefreshDone(timeout = 40000) {
  await cdp.waitFor(`${VM}.autoRefresh.state === 'done' || ${VM}.autoRefresh.state === 'error' || ${VM}.autoRefresh.state === 'idle'`, timeout, '刷新结束');
  return cdp.eval(`return ${VM}.autoRefresh.state;`);
}

async function forceRefresh() {
  await cdp.eval(`${VM}.runAutoRefresh(true); return true;`);
}

async function pageInfo() {
  return cdp.eval(`
    return {
      id: Number(location.pathname.split('/').pop()),
      name: (document.querySelector('.proj-card h1') || {}).textContent || '',
      path: ${VM}.p && ${VM}.p.path,
      intro: (document.querySelector('.info-intro') || {}).textContent || '',
      stats: [...document.querySelectorAll('#sec-stats .stats-num-val')].map(e => e.textContent),
      badges: [...document.querySelectorAll('.dbadge')].map(e => e.textContent.replace(/\\s+/g, ' ').trim()),
      state: ${VM}.autoRefresh.state,
    };`);
}

async function shoot(file) {
  const rect = await cdp.eval(`
    const el = document.querySelector('.auto-refresh-strip') || document.querySelector('.proj-card');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: 0, y: Math.max(0, r.top + window.scrollY - 4), width: Math.min(1000, r.width), height: r.height + 8 };`);
  if (!rect) return;
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
  writeFileSync(path.join(outDir, file), Buffer.from(res.data, 'base64'));
  console.log(`  · 截图 ${file}`);
}

function editReadme(projectPath, text) {
  writeFileSync(path.join(projectPath, 'README.md'), `# ${path.basename(projectPath)}\n\n${text}\n`, 'utf8');
}

function addFile(projectPath, rel, content) {
  const p = path.join(projectPath, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

function commitAll(projectPath, msg) {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', '-A'], { cwd: projectPath });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '-q', '-m', msg], { cwd: projectPath });
}

async function main() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`); if (r.ok) break; } catch { /* wait */ }
    await sleep(250);
  }
  const t = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  cdp = await CDP.connect(t.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  cdp.listeners.push((m) => {
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request.url || '';
      if (u.includes('/api/refresh') && m.params.request.method === 'POST') refreshPosts++;
    }
  });

  // ---------------------------------------------------------------- 1
  console.log('\n[1] 进入详情页：自动刷新采集数据');
  await goto(`${BASE}/project/${a}`);
  await settle();
  await sleep(2500);                      // 让首次自动刷新跑完（有 30s 冷却）
  const before = await pageInfo();
  check(before.id === Number(a), `打开了项目 ${before.id}`);
  check(before.state === 'idle' || before.state === 'done', `自动刷新已结束（state=${before.state}）`);

  editReadme(path_a, '外部改过的简介：自动刷新应更新。');
  addFile(path_a, 'src/nested/deep/new.js', 'console.log("new")\n');
  commitAll(path_a, 'feat: 外部新增提交');
  await forceRefresh();
  const st1 = await waitRefreshDone();
  check(st1 === 'done', `刷新完成（state=${st1}）`);
  await sleep(400);
  const after = await pageInfo();
  check(after.intro.includes('外部改过的简介'), `简介已更新：${after.intro.slice(0, 30)}`);
  check(JSON.stringify(after.stats) !== JSON.stringify(before.stats),
    `文件统计已更新 ${before.stats.join('/')} -> ${after.stats.join('/')}`);
  check(JSON.stringify(after.badges) !== JSON.stringify(before.badges),
    `提交徽章已更新 ${after.badges.join(' ')}`);
  const notReloaded = await cdp.eval(`return window.__tlPageApp === window.__tlPageApp && !!window.tlOnWindowResume;`);
  check(notReloaded === true, '页面未整页重载（软导航/自动更新为局部替换）');
  await shoot('01-updated.png');

  // ---------------------------------------------------------------- 2
  console.log('\n[2] 草稿保护：描述 / 笔记 / 日志 / 启动项');
  await cdp.eval(`
    const vm = ${VM};
    vm.openRecord('desc'); vm.openRecord('notes'); vm.openRecord('logs');
    if (vm.noteDraft === null) vm.noteDraft = '';
    if (vm.logDraft === null) vm.openLogDraft();
    return true;`);
  await sleep(300);
  const DRAFT = { desc: '草稿描述：刷新不该覆盖我', note: '笔记草稿：还没保存', log: '日志草稿：还没保存' };
  await cdp.eval(`
    const vm = ${VM};
    const ta = document.querySelector('#sec-desc textarea');
    ta.value = ${JSON.stringify(DRAFT.desc)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    vm.noteDraft = ${JSON.stringify(DRAFT.note)};
    vm.logDraft = ${JSON.stringify(DRAFT.log)};
    vm.launch.__probe = 'keep';
    return true;`);
  await sleep(300);
  const dirtyBefore = await cdp.eval(`return ${VM}.descDirty;`);
  check(dirtyBefore === true, '描述进入未保存状态');

  editReadme(path_a, '第二次外部修改：此时页面上有草稿。');
  await forceRefresh();
  const st2 = await waitRefreshDone();
  await sleep(400);
  const draftState = await cdp.eval(`
    const vm = ${VM};
    return {
      desc: document.querySelector('#sec-desc textarea').value,
      note: vm.noteDraft,
      log: vm.logDraft,
      dirty: vm.descDirty,
      launch: vm.launch && vm.launch.__probe,
      baseline: vm.descBaseline,
      intro: (document.querySelector('.info-intro') || {}).textContent || '',
    };`);
  check(st2 === 'done', `刷新完成（state=${st2}）`);
  check(draftState.desc === DRAFT.desc, '描述草稿保留');
  check(draftState.dirty === true, '描述仍标记为未保存（baseline 未被覆盖）');
  check(draftState.note === DRAFT.note, '笔记草稿保留');
  check(draftState.log === DRAFT.log, '变更日志草稿保留');
  check(draftState.launch === 'keep', '启动项对象未被重建（编辑态不丢）');
  check(draftState.intro.includes('第二次外部修改'), `采集数据仍照常更新：${draftState.intro.slice(0, 26)}`);
  await shoot('02-drafts.png');

  // ---------------------------------------------------------------- 3
  console.log('\n[3] 刷新期间切换项目：旧结果不回填');
  await cdp.eval(`${VM}.runAutoRefresh(true); window.tlSoftNavigate('/project/${b}'); return true;`);
  await sleep(2000);
  const other = await pageInfo();
  check(other.id === Number(b), `已切到项目 ${other.id}`);
  check(other.path.includes('auto-detail-b'), `新页面数据属于新项目：${other.path}`);
  check(other.name.includes('auto-detail-b'), `标题正确：${other.name}`);

  // ---------------------------------------------------------------- 4
  console.log('\n[4] 连续切换窗口：重复请求合并');
  await goto(`${BASE}/project/${a}`);
  await settle();
  await sleep(2500);
  refreshPosts = 0;
  await cdp.eval(`
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('focus'));
    return true;`);
  await sleep(1500);
  check(refreshPosts === 1, `5 次 focus 只发出 ${refreshPosts} 个刷新请求`);

  console.log('\n[4b] 桌面壳恢复钩子 tlOnWindowResume');
  const hasHook = await cdp.eval(`return typeof window.tlOnWindowResume === 'function';`);
  check(hasHook === true, '页面已注册 tlOnWindowResume（桌面壳 shown/restored 后调用它）');
  refreshPosts = 0;
  await cdp.eval(`window.tlOnWindowResume(); return true;`);
  await sleep(1400);
  check(refreshPosts === 1, `调用 tlOnWindowResume 触发 ${refreshPosts} 个刷新请求`);

  // ---------------------------------------------------------------- 5
  console.log('\n[5] 刷新失败：轻量错误提示 + 重试');
  await goto(`${BASE}/project/${a}`);
  await settle();
  await sleep(2500);
  await cdp.send('Network.setBlockedURLs', { urls: ['*api/refresh*'] });
  await forceRefresh();
  await cdp.waitFor(`${VM}.autoRefresh.state === 'error'`, 20000, '错误态');
  const errState = await cdp.eval(`
    const bar = document.querySelector('.auto-refresh-strip');
    return { text: bar ? bar.innerText.replace(/\\s+/g, ' ').trim() : '',
             hasRetry: !!(bar && bar.querySelector('.btn')),
             stillLoaded: !!document.querySelector('.proj-card h1') };`);
  check(errState.text.includes('自动更新失败'), `错误提示：${errState.text.slice(0, 40)}`);
  check(errState.hasRetry, '提供重试按钮');
  check(errState.stillLoaded, '失败不影响页面已有内容');
  await shoot('03-error.png');
  await cdp.send('Network.setBlockedURLs', { urls: [] });
  await cdp.eval(`
    const btn = document.querySelector('.auto-refresh-strip .btn');
    if (btn) btn.click();
    return true;`);
  const st3 = await waitRefreshDone(30000);
  check(st3 === 'done' || st3 === 'idle', `重试后恢复（state=${st3}）`);

  console.log(`\n===== 结果：${fails.length ? fails.length + ' 项失败' : '全部通过'} =====`);
  if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exitCode = 1; }
  cdp.ws.close();
  proc.kill();
}

main().catch((e) => {
  console.error('验证异常：', e.message);
  try { proc.kill(); } catch { /* ignore */ }
  process.exitCode = 1;
});
