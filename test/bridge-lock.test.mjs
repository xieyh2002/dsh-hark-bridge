/**
 * 并发与取消的回归测试（对应审查意见 S1 / S2）
 *
 * 这两条都是「看起来能用、实际会互相踩」的问题，必须靠测试钉住：
 *  - 跨进程锁：DSH 开两个窗口时，两个 HarkBridge 各自有自己的 queue，
 *    没有锁就会两个进程抢同一个输入框。
 *  - 排队取消：用户按停时如果还要等前一个请求跑完才返回，界面会假死。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
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

// ---- 6. 长请求不能被当成残留抢走（审查意见 B1） ----
//
// 早先用 mtime 判断生死：任何超过 10 分钟的请求都会被别人当残留删掉锁。
// 而 timeoutMin 上限就是 120 分钟，20 分钟的请求完全正常。
// 现在有 pid 就以 pid 为准——自己的 pid 当然活着，mtime 再老也不该被抢。
{
  // 造一个「活着但很久没动」的锁：pid 用自己，mtime 拨到 1 小时前。
  const lockFile = join(dir, 'bridge.lock');
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'other-holder', at: 0 }));
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(lockFile, old, old);

  const ac = new AbortController();
  const waiting = acquireLock(dir, ac.signal);
  await sleep(400);
  ac.abort(new Error('不等了'));
  await assert.rejects(waiting, (e) => e.name === 'AbortError', '持有者还活着，就不该抢锁');
  assert.equal(existsSync(lockFile), true, '别人的锁不能被删');
  // 用完自己清掉：这个锁的 pid 就是本进程，留着会让下面每个用例都抢不到。
  rmSync(lockFile, { force: true });
  console.log('ok   长时间持锁不会被误抢');
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

rmSync(dir, { recursive: true, force: true });
console.log('bridge lock/cancel tests passed');
process.exit(0);
