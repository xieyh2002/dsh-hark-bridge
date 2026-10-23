/**
 * 并发与取消的回归测试（对应审查意见 S1 / S2）
 *
 * 这两条都是「看起来能用、实际会互相踩」的问题，必须靠测试钉住：
 *  - 跨进程锁：DSH 开两个窗口时，两个 HarkBridge 各自有自己的 queue，
 *    没有锁就会两个进程抢同一个输入框。
 *  - 排队取消：用户按停时如果还要等前一个请求跑完才返回，界面会假死。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// store.js 会读写 dataDir()，测试必须指到临时目录，绝不能碰用户真实配置。
process.env.DSH_HARK_BRIDGE_HOME = mkdtempSync(join(tmpdir(), 'dsh-hark-lock-'));
const dir = process.env.DSH_HARK_BRIDGE_HOME;

const { HarkBridge, acquireLock } = await import('../lib/bridge.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. 互斥：第二个必须等第一个释放 ----
{
  const order = [];
  const release1 = await acquireLock(dir);
  order.push('lock1');

  const p2 = acquireLock(dir).then((release2) => {
    order.push('lock2');
    return release2;
  });

  await sleep(300);
  assert.deepEqual(order, ['lock1'], '第一个锁还没放，第二个不该拿到');

  release1();
  order.push('release1');
  const release2 = await p2;
  assert.deepEqual(order, ['lock1', 'release1', 'lock2'], '释放后第二个才拿到');
  release2();
  console.log('ok   锁互斥');
}

// ---- 2. 锁文件在释放后消失 ----
assert.equal(existsSync(join(dir, 'bridge.lock')), false, '释放后锁文件要删掉');
console.log('ok   释放即清理');

// ---- 3. 残留锁（持有进程已死）能被抢过来 ----
{
  // pid 用一个几乎不可能存在的值，模拟上一轮被强杀的进程留下的锁。
  writeFileSync(join(dir, 'bridge.lock'), JSON.stringify({ pid: 999999, at: 0 }));
  const t0 = Date.now();
  const release = await acquireLock(dir);
  const cost = Date.now() - t0;
  assert.ok(cost < 2000, `残留锁应立刻被抢过来，实际花了 ${cost}ms`);
  release();
  console.log(`ok   残留锁自动回收（${cost}ms）`);
}

// ---- 4. 已在等待时取消，立刻抛 AbortError ----
{
  const release = await acquireLock(dir);
  const ac = new AbortController();
  const waiting = acquireLock(dir, ac.signal);
  await sleep(150);
  const t0 = Date.now();
  ac.abort(new Error('用户按了停止'));
  await assert.rejects(waiting, (e) => e.name === 'AbortError' && /停止/.test(e.message));
  const cost = Date.now() - t0;
  assert.ok(cost < 500, `取消应立即返回，实际花了 ${cost}ms`);
  release();
  console.log(`ok   等锁时取消（${cost}ms）`);
}

// ---- 5. 排队中取消：不能先跑完前一个请求 ----
{
  const calls = [];
  // 第一个请求永远不结束，模拟 Hark 迟迟不回。
  const stuck = async function* () {
    calls.push('start');
    while (true) {
      yield { ok: true, phase: 'poll', text: '' };
      await sleep(50);
    }
  };
  const bridge = new HarkBridge(
    () => ({ harkUrl: 'https://hark.test/p/1', triggerWords: [], browserPath: '', inputSelector: '', sendSelector: '', timeoutMin: 20, loginWaitSec: 1, pollMs: 200, settleMs: 0, maxChars: 60000 }),
    { streamScript: stuck, log: { warn() {} }, lockDir: dir },
  );

  const first = bridge.ask('chat', '第一个请求');
  first.catch(() => {});
  await sleep(200);

  const ac = new AbortController();
  const t0 = Date.now();
  const second = bridge.ask('chat', '第二个请求', { signal: ac.signal });
  ac.abort(new Error('用户按了停止'));

  await assert.rejects(second, (e) => e.name === 'AbortError');
  const cost = Date.now() - t0;
  assert.ok(cost < 500, `排队中的请求应立刻抛出，实际等了 ${cost}ms`);
  assert.equal(calls.filter((x) => x === 'start').length, 1, '被取消的请求不该真的去启动 ego');
  console.log(`ok   排队中取消不阻塞（${cost}ms）`);
}

// ---- 6. 活着的持有者不能被抢（审查意见 B1 + S-a） ----
//
// 早先用 mtime 判断生死：任何超过 10 分钟的请求都会被别人当残留删掉锁。
// 而 timeoutMin 上限就是 120 分钟，20 分钟的请求完全正常。
// 现在持有者每 60 秒心跳一次刷新 mtime，所以「pid 活着 + mtime 新」= 真的在干活。
{
  const lockFile = join(dir, 'bridge.lock');
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'other-holder', at: Date.now() }));

  const ac = new AbortController();
  const waiting = acquireLock(dir, ac.signal);
  await sleep(400);
  ac.abort(new Error('不等了'));
  await assert.rejects(waiting, (e) => e.name === 'AbortError', '持有者还在心跳，就不该抢锁');
  assert.equal(existsSync(lockFile), true, '别人的锁不能被删');
  // 用完自己清掉：这个锁的 pid 就是本进程，留着会让下面每个用例都抢不到。
  rmSync(lockFile, { force: true });
  console.log('ok   持有者还在心跳时不会被误抢');
}

// ---- 6b. pid 被复用也要能回收（审查意见 S-a） ----
//
// 只信 pid 会死锁：持锁进程被强杀后，Windows 会把它的 pid 分给别的进程，
// isAlive 于是永远返回 true，那把锁再没人能回收。
// 所以「心跳停了 3 个周期」也算残留——时间戳骗不过。
{
  const lockFile = join(dir, 'bridge.lock');
  // pid 用自己（活着），但 mtime 拨到 4 分钟前：心跳早已停摆，是残留。
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'dead-heartbeat', at: 0 }));
  const old = new Date(Date.now() - 4 * 60 * 1000);
  utimesSync(lockFile, old, old);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('抢不到')), 3000);
  let release = null;
  try {
    release = await acquireLock(dir, ac.signal);
  } finally {
    clearTimeout(timer);
  }
  assert.ok(release, '心跳停摆的锁必须能被回收，否则 pid 复用会永久死锁');
  release();
  console.log('ok   心跳停摆的锁能回收（pid 复用不死锁）');
}

// ---- 7. 锁被接管后，原来的持锁方不能删别人的锁（审查意见 B1） ----
//
// 这是 B1 真正的杀伤点：老 release 无条件 rmSync。A 的锁被 B 抢走（无论抢得对不对），
// A 结束时会把 B 的锁删掉，于是 C 畅通无阻地进来，B 和 C 同时往 Hark 里打字。
{
  const release1 = await acquireLock(dir);
  const lockFile = join(dir, 'bridge.lock');
  // 模拟「锁已被别人接管」：把内容换成另一个 token。
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'someone-else', at: Date.now() }));
  release1();
  assert.equal(existsSync(lockFile), true, 'token 不是自己的，release 不能删');
  rmSync(lockFile, { force: true });
  console.log('ok   只删自己的锁');
}

// ---- 8. 不同 Hark 地址互不排队（Hark 方案 T4） ----
//
// 锁保护的是「同一个对话框只有一个人在打字」。早先所有会话共用一个 bridge.lock，
// 语义变成「整台机器只能有一个人用 Hark」：两个项目各连一个 Hark 页，
// 明明互不相干却要排队，最长白等 2 分钟。
{
  const urlA = 'https://hark.test/p/a';
  const urlB = 'https://hark.test/p/b';
  const relA = await acquireLock(dir, undefined, urlA);
  // A 还持着锁，B 必须立刻拿到——它们不是同一个对话框。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('被 A 挡住了')), 2000);
  let relB = null;
  try {
    relB = await acquireLock(dir, ac.signal, urlB);
  } finally {
    clearTimeout(timer);
  }
  assert.ok(relB, '不同地址必须能同时持锁');
  // 而同一个地址仍然互斥：A 没放锁，A 自己也拿不到第二把。
  const ac2 = new AbortController();
  const t2 = setTimeout(() => ac2.abort(new Error('同地址应当互斥')), 400);
  await assert.rejects(acquireLock(dir, ac2.signal, urlA), (e) => e.name === 'AbortError', '同一个地址必须互斥');
  clearTimeout(t2);
  relB();
  relA();
  console.log('ok   不同 Hark 地址互不排队，同地址仍然互斥');
}

// ---- 9. 锁文件名按地址区分，且不污染目录 ----
{
  // 前面的用例里还有一个永远不结束的请求持着它自己的锁，所以只看「新增了哪个」。
  const before = new Set(readdirSync(dir));
  const relA = await acquireLock(dir, undefined, 'https://hark.test/p/a');
  const added = readdirSync(dir).filter((f) => f.endsWith('.lock') && !before.has(f));
  assert.equal(added.length, 1, `应当新增一个锁文件，实际 ${added.join(',') || '无'}`);
  assert.ok(/^bridge-[0-9a-f]{8}\.lock$/.test(added[0]), `锁名格式不对：${added[0]}`);
  // 名字里不能出现网址片段（斜杠会把锁文件变成子目录，直接 ENOENT）。
  assert.ok(!added[0].includes('hark.test'), '锁名不能带网址原文');
  relA();
  assert.equal(existsSync(join(dir, added[0])), false, '释放后自己的锁要删掉');
  console.log('ok   锁文件名是 bridge-<hash>.lock，不含网址原文');
}

rmSync(dir, { recursive: true, force: true });
console.log('bridge lock/cancel tests passed');
process.exit(0);
