/** R3 首页自动更新验证（CDP）。用法：node verify-autorefresh-home.mjs plan.json */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { port, debugPort, outDir, chrome, a, b, c, path_a, path_b } = plan;
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

const profile = mkdtempSync(path.join(tmpdir(), 'lpa-home-'));
const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--no-pings', '--no-proxy-server',
  '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1440,900',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeLog = '';
proc.stderr.on('data', (d) => { chromeLog += d.toString(); });

let cdp = null;
let refreshPosts = 0;
const VM = 'window.__tlHomeVM';

async function goto(url) {
  const loaded = cdp.once('Page.loadEventFired', 40000).catch(() => {});
  await cdp.send('Page.navigate', { url });
  await loaded;
}

async function settle() {
  await cdp.waitFor(`${VM} && !${VM}.loading`, 30000, '首页加载');
  await sleep(600);
}

async function forceRefresh() {
  await cdp.eval(`${VM}.runAutoRefresh(true); return true;`);
}

async function waitDone(timeout = 60000) {
  await cdp.waitFor(`${VM}.autoRefresh.state === 'done' || ${VM}.autoRefresh.state === 'error' || ${VM}.autoRefresh.state === 'idle'`, timeout, '刷新结束');
  return cdp.eval(`return ${VM}.autoRefresh.state;`);
}

async function homeInfo() {
  return cdp.eval(`
    const vm = ${VM};
    const cards = [...document.querySelectorAll('.card[data-project-id]')];
    const aCard = document.querySelector('.card[data-project-id="${a}"]');
    return {
      order: vm.sorted.map(p => p.id),
      domOrder: cards.map(el => Number(el.dataset.projectId)),
      filteredCount: vm.filtered.length,
      q: vm.q,
      projectOrder: (vm.projectOrder || []).slice(),
      scrollY: Math.round(window.scrollY),
      state: vm.autoRefresh.state,
      auto: JSON.parse(JSON.stringify(vm.autoRefresh)),
      strip: (document.querySelector('.auto-refresh-strip') || {}).innerText || '',
      lastCommit: aCard ? (aCard.dataset.lastCommit || '') : '',
      hash: aCard ? (aCard.dataset.lastCommitHash || '') : '',
    };`);
}

async function shoot(file) {
  const rect = await cdp.eval(`
    const el = document.querySelector('.auto-refresh-strip');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: 0, y: Math.max(0, r.top + window.scrollY - 4), width: Math.min(1200, r.width), height: r.height + 8 };`);
  if (!rect) return;
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
  writeFileSync(path.join(outDir, file), Buffer.from(res.data, 'base64'));
  console.log(`  · 截图 ${file}`);
}

function addFile(p, rel, content) {
  const f = path.join(p, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, content, 'utf8');
}

function commitAll(p, msg) {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', '-A'], { cwd: p });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '-q', '-m', msg], { cwd: p });
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 600, deviceScaleFactor: 1, mobile: false });
  cdp.listeners.push((m) => {
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request.url || '';
      if (u.includes('/api/refresh') && m.params.request.method === 'POST') refreshPosts++;
    }
  });

  // ---------------------------------------------------------------- 1
  console.log('\n[1] 打开首页：后台批量更新，首屏正常显示');
  await goto(`${BASE}/`);
  await settle();
  await sleep(3000);                    // 首次批量刷新
  let info = await homeInfo();
  check(info.domOrder.length === 3, `首屏渲染 3 张卡片（${info.domOrder.join(',')}）`);
  check(info.state === 'idle' || info.state === 'done', `首次自动更新已结束（state=${info.state}）`);
  const orderBefore = info.order.slice();

  console.log('\n[2] 外部新增提交后：卡片最近提交同步');
  const beforeCommit = { last: info.lastCommit, hash: info.hash };
  addFile(path_a, 'src/extra/feature.js', 'export const x = 1;\n');
  writeFileSync(path.join(path_a, 'README.md'), '# auto-home-a\n\n简介：改过的 a。\n', 'utf8');
  commitAll(path_a, 'feat: 首页自动更新验证用提交');
  await forceRefresh();
  const st1 = await waitDone();
  await sleep(500);
  info = await homeInfo();
  check(st1 === 'done', `刷新完成（state=${st1}）`);
  check(info.lastCommit !== beforeCommit.last || info.hash !== beforeCommit.hash,
    `卡片最近提交已更新：${beforeCommit.last} -> ${info.lastCommit}`);
  check(JSON.stringify(info.order) === JSON.stringify(orderBefore), '卡片顺序未变（排序规则不受后台任务影响）');
  check(info.auto.changed >= 1, `任务回报 ${info.auto.changed} 个项目有变化`);
  await shoot('01-home-updated.png');

  // ---------------------------------------------------------------- 3
  console.log('\n[3] 搜索 / 筛选状态在刷新后保留');
  await cdp.eval(`${VM}.q = 'auto-home-a'; return true;`);
  await sleep(500);
  const filteredBefore = await homeInfo();
  check(filteredBefore.filteredCount === 1, `搜索命中 ${filteredBefore.filteredCount} 个项目`);
  addFile(path_b, 'src/extra/b.js', 'console.log("b")\n');
  await forceRefresh();
  const st2 = await waitDone();
  await sleep(500);
  const filteredAfter = await homeInfo();
  check(st2 === 'done', `刷新完成（state=${st2}）`);
  check(filteredAfter.q === 'auto-home-a', `搜索词保留：「${filteredAfter.q}」`);
  check(filteredAfter.filteredCount === 1, `筛选结果保持 ${filteredAfter.filteredCount} 个`);

  // ---------------------------------------------------------------- 4
  console.log('\n[4] 拖动顺序与滚动位置在刷新后保留');
  await cdp.eval(`${VM}.q = ''; ${VM}.statusFilter = ''; ${VM}.tagFilter = ''; ${VM}.catFilter = ''; return true;`);
  await sleep(400);
  await cdp.eval(`return ${VM}.moveProject(${c}, ${a}, true);`);
  await sleep(900);
  const moved = await homeInfo();
  const orderMoved = moved.order.slice();
  const orderSaved = moved.projectOrder.slice();
  check(JSON.stringify(orderMoved) !== JSON.stringify(orderBefore), `拖动后顺序变化 ${orderMoved.join(',')}`);

  await cdp.eval(`window.scrollTo(0, 320); return true;`);
  await sleep(300);
  const scrollBefore = await cdp.eval(`return Math.round(window.scrollY);`);
  addFile(path_b, 'src/extra/c.js', 'console.log("c")\n');
  await forceRefresh();
  const st3 = await waitDone();
  await sleep(600);
  const afterMove = await homeInfo();
  check(st3 === 'done', `刷新完成（state=${st3}）`);
  check(JSON.stringify(afterMove.order) === JSON.stringify(orderMoved),
    `刷新后顺序保持 ${afterMove.order.join(',')}`);
  check(JSON.stringify(afterMove.projectOrder) === JSON.stringify(orderSaved), '手动排序记录未被覆盖');
  check(afterMove.scrollY === scrollBefore || Math.abs(afterMove.scrollY - scrollBefore) <= 2,
    `滚动位置保持 ${scrollBefore} -> ${afterMove.scrollY}`);

  // ---------------------------------------------------------------- 5
  console.log('\n[5] 连续切换窗口：重复请求合并');
  await goto(`${BASE}/`);
  await settle();
  await sleep(2500);
  refreshPosts = 0;
  await cdp.eval(`
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('focus'));
    return true;`);
  await sleep(1600);
  check(refreshPosts === 1, `5 次 focus 只发出 ${refreshPosts} 个刷新请求`);

  // ---------------------------------------------------------------- 6
  console.log('\n[6] 刷新失败：轻量错误提示 + 重试');
  await cdp.send('Network.setBlockedURLs', { urls: ['*api/refresh*'] });
  await forceRefresh();
  await cdp.waitFor(`${VM}.autoRefresh.state === 'error'`, 20000, '错误态');
  const errState = await cdp.eval(`
    const bar = document.querySelector('.auto-refresh-strip');
    return { text: (bar || {}).innerText || '', hasRetry: !!(bar && bar.querySelector('.btn')),
             cards: document.querySelectorAll('.card[data-project-id]').length };`);
  check(errState.text.includes('自动更新失败'), `错误提示：${errState.text.replace(/\s+/g, ' ').slice(0, 36)}`);
  check(errState.hasRetry, '提供重试按钮');
  check(errState.cards === 3, '失败不影响列表展示');
  await shoot('02-home-error.png');
  await cdp.send('Network.setBlockedURLs', { urls: [] });
  await cdp.eval(`const b = document.querySelector('.auto-refresh-strip .btn'); if (b) b.click(); return true;`);
  const st4 = await waitDone(40000);
  check(st4 === 'done' || st4 === 'idle', `重试后恢复（state=${st4}）`);

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
