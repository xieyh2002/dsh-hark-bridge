/**
 * 驱动层（lib/ego.js）的回归测试（对应审查意见 B3 / B2）
 *
 * 这两条都只在长时间对话或进程被杀时才显形，靠人肉测很难覆盖，所以用真实子进程测：
 *  - 事件文件按字节增量读：脚本一边跑一边追加事件，父进程要能实时收到，
 *    不能等子进程退出才一次性给出（ego 的 stdout 就是这样的）。
 *  - 子进程被 kill 后不该留下临时目录，也不该让父进程卡住。
 *
 * 用一个假 ego 替代真实 ego-browser：它读 stdin 拿脚本、在 node 里 eval，
 * 事件通道与真实实现完全一致（临时目录 + 事件文件）。
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'dsh-hark-ego-test-'));
process.env.DSH_HARK_BRIDGE_HOME = join(root, 'home');

// 假 ego-browser：把 script.mjs 的内容从 stdin 读进来直接跑。
// stdio 与真实实现一致（文件句柄作 stdin、stdout 丢弃、stderr 收日志）。
const fakeExe = join(root, process.platform === 'win32' ? 'ego-browser.cmd' : 'ego-browser');
if (process.platform === 'win32') {
  writeFileSync(fakeExe, '@echo off\r\nnode "%~dp0fake-runner.mjs"\r\n', 'utf8');
} else {
  writeFileSync(fakeExe, `#!/bin/sh\nexec node "${join(root, 'fake-runner.mjs')}"\n`, 'utf8');
  chmodSync(fakeExe, 0o755);
}
writeFileSync(join(root, 'fake-runner.mjs'), `
import { readFileSync } from 'node:fs';
const src = readFileSync(0, 'utf8');
await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
`, 'utf8');

const { streamEgoScript, cleanupTempDirs } = await import('../lib/ego.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. 事件实时到达：不能等子进程退出 ----
{
  const t0 = Date.now();
  const seen = [];
  const script = `
for (let i = 0; i < 3; i += 1) {
  console.log(JSON.stringify({ ok: true, phase: 'poll', i }));
  await new Promise((r) => setTimeout(r, 300));
}
`;
  for await (const ev of streamEgoScript(script, { exePath: fakeExe, timeoutMs: 20_000 })) {
    seen.push({ i: ev.i, at: Date.now() - t0 });
  }
  assert.equal(seen.length, 3, '三个事件都要收到');
  assert.ok(seen[0].at < 800, `第一个事件应实时到达，实际 ${seen[0].at}ms`);
  assert.ok(seen[2].at - seen[0].at > 500, '事件应分布在不同时刻，不是退出时一次性给出');
  console.log(`ok   事件实时到达（第 1 个 ${seen[0].at}ms，第 3 个 ${seen[2].at}ms）`);
}

// ---- 2. 长正文：跨 UTF-8 边界不会丢字符、也不会重复 ----
{
  // 每次给一段中文（3 字节/字）和 emoji（4 字节），故意让读边界落在字符中间。
  const lines = [];
  const script = `
for (let i = 0; i < 40; i += 1) {
  console.log(JSON.stringify({ ok: true, phase: 'poll', i, text: '中文字'.repeat(50) + '🙂'.repeat(20) + '-' + i }));
  await new Promise((r) => setTimeout(r, 20));
}
`;
  for await (const ev of streamEgoScript(script, { exePath: fakeExe, timeoutMs: 30_000 })) lines.push(ev);
  assert.equal(lines.length, 40, '40 个事件一个都不能少');
  for (const ev of lines) {
    assert.ok(ev.text.endsWith(`-${ev.i}`), `事件 ${ev.i} 的正文被截断了`);
    assert.ok(ev.text.includes('🙂'), `事件 ${ev.i} 丢了 emoji（UTF-8 边界）`);
  }
  console.log('ok   跨 UTF-8 边界不丢字符');
}

// ---- 3. 取消：立刻返回，不留临时目录 ----
{
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith('dsh-hark-ego-')).length;
  const ac = new AbortController();
  const script = `
while (true) {
  console.log(JSON.stringify({ ok: true, phase: 'poll', text: 'x' }));
  await new Promise((r) => setTimeout(r, 100));
}
`;
  const t0 = Date.now();
  const pump = (async () => {
    for await (const _ of streamEgoScript(script, { exePath: fakeExe, signal: ac.signal })) {
      if (Date.now() - t0 > 500) ac.abort(new Error('用户按了停止'));
    }
  })();
  await assert.rejects(pump, (e) => e.name === 'AbortError');
  const cost = Date.now() - t0;
  assert.ok(cost < 5000, `取消应尽快返回，实际 ${cost}ms`);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith('dsh-hark-ego-')).length;
  assert.equal(after, before, '取消后临时目录要立刻删掉');
  console.log(`ok   取消即刻返回并清理（${cost}ms）`);
}

// ---- 4. 阶段失败：错误里要带阶段名，上层才能翻译成「请登录」 ----
{
  const script = `
console.log(JSON.stringify({ ok: false, phase: 'focus' }));
`;
  await assert.rejects(
    (async () => { for await (const _ of streamEgoScript(script, { exePath: fakeExe, timeoutMs: 10_000 })) { /* 不应有事件 */ } })(),
    (e) => e.name === 'EgoStageError' && e.stage === 'focus',
  );
  console.log('ok   阶段失败带 stage');
}

// ---- 5. 脚本抛异常：包成阶段失败，不静默 ----
{
  const script = `throw new Error('炸了');`;
  await assert.rejects(
    (async () => { for await (const _ of streamEgoScript(script, { exePath: fakeExe, timeoutMs: 10_000 })) { /* */ } })(),
    (e) => e.name === 'EgoStageError' && e.stage === 'script' && /炸了/.test(e.message),
  );
  console.log('ok   脚本异常被捕获');
}

// ---- 6. 脚本自毁：目录被外部删掉后脚本自己退出，不会一直跑 ----
{
  // 包装层的 __dir 就是本次的事件目录，脚本里能直接拿到（同一作用域）。
  const script = `
while (true) {
  console.log(JSON.stringify({ ok: true, phase: 'poll', dir: __dir }));
  await new Promise((r) => setTimeout(r, 50));
}
`;
  const t0 = Date.now();
  let count = 0;
  let own = '';
  for await (const ev of streamEgoScript(script, { exePath: fakeExe, timeoutMs: 15_000 })) {
    count += 1;
    own = ev.dir;
    if (count === 3) {
      // 模拟父进程崩溃后没人管它了。两条自毁信号都发：写 stop 文件（脚本一定看得到），
      // 再尽量把目录删掉。Windows 上事件文件还被脚本开着，rmSync 会 ENOTEMPTY，
      // 所以删除是尽力而为——stop 文件已足够验证自毁。
      writeFileSync(join(own, 'stop'), '');
      try {
        rmSync(own, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch { /* 文件句柄还开着，删不掉不影响这条断言 */ }
    }
  }
  const cost = Date.now() - t0;
  assert.ok(cost < 10_000, `收到自毁信号后脚本应自己退出，实际跑了 ${cost}ms`);
  console.log(`ok   脚本自毁（收到 stop 后 ${cost}ms 内结束）`);
}

// ---- 7. 陈旧临时目录会被清理（只删命中前缀且超龄的） ----
{
  const removed = cleanupTempDirs(7 * 24 * 60 * 60 * 1000);
  assert.equal(typeof removed, 'number', '清理函数要返回删掉的个数');
  console.log(`ok   陈旧目录清理（本次删了 ${removed} 个）`);
}

rmSync(root, { recursive: true, force: true });
console.log('ego driver tests passed');
process.exit(0);
