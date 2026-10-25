/**
 * 宿主 Node 版本检查（0.10.0）
 *
 * 重点在边界：每条线的修复版本本身算通过、差一个补丁号算失败；
 * 24.0.0 这种「比 22.23.4 大但没修」的版本必须拦住——这正是不能写 `>=22.23.4` 的原因。
 */
import assert from 'node:assert/strict';
import { checkNodeVersion, PATCHED_MIN } from '../lib/node-check.js';

const ok = (v) => checkNodeVersion(v).ok;

// ---- 1. 各线的修复版本及以上通过 ----
for (const v of ['22.23.4', 'v22.23.5', '22.24.0', '24.22.1', '24.30.0', '26.12.1', '26.13.0', '27.0.0', '28.1.0']) {
  assert.equal(ok(v), true, `${v} 应当通过`);
}
console.log('ok   修复版本及更高通过');

// ---- 2. 各线差一点的版本失败，且 hint 给出该线的目标版本 ----
for (const [v, want] of [['22.23.3', '22.23.4'], ['22.0.0', '22.23.4'], ['24.22.0', '24.22.1'], ['24.0.0', '24.22.1'], ['26.12.0', '26.12.1']]) {
  const r = checkNodeVersion(v);
  assert.equal(r.ok, false, `${v} 应当失败`);
  assert.ok(r.hint.includes(want), `${v} 的提示里要有目标版本 ${want}`);
  assert.ok(r.detail.includes('CVE-2026-111497'), '要说清缺的是哪次修复');
}
console.log('ok   未修复的 22/24/26 被拦住，并指向本线目标版本');

// ---- 3. EOL 线失败，提示换线 ----
for (const v of ['20.20.2', '18.20.0', '21.7.3', '23.11.1', '25.9.0']) {
  const r = checkNodeVersion(v);
  assert.equal(r.ok, false, `${v} 应当失败`);
  assert.ok(r.detail.includes('停止支持'), `${v} 要说明已停止支持`);
  for (const min of Object.values(PATCHED_MIN)) assert.ok(r.hint.includes(min.join('.')), '换线提示要列全三条线');
}
console.log('ok   EOL 线提示换到受支持的版本线');

// ---- 4. 读不出版本号不算错误 ----
for (const v of ['', null, 'abc']) assert.equal(checkNodeVersion(v).ok, null);
console.log('ok   版本号无法解析时只提醒，不报失败');

// ---- 5. 默认读当前进程：只验契约，不要求测试机必须是修复版 ----
//
// 早先这里断言 checkNodeVersion().ok === true，等于要求「跑测试的 Node 必须是
// 修复版」。那是把环境要求写进了逻辑测试：CI 的 node: 24 那一格实际拿到
// 24.21.0（低于 24.22.1），三个 job 直接红；本地用旧版本的人也同样跑不过。
// 检测逻辑对不对，和测试机装什么版本无关——边界值已在前 4 组里穷举过了。
{
  const cur = checkNodeVersion();
  const running = String(process.versions?.node || '').replace(/^v/, '');
  assert.equal(cur.version, running, '默认参数必须读 process.versions.node');
  assert.ok([true, false, null].includes(cur.ok), 'ok 只能是 true / false / null');
  assert.equal(typeof cur.detail, 'string');
  assert.ok(cur.detail.length > 0, 'detail 不能为空');
  assert.ok(!cur.detail.includes('undefined'), 'detail 不能出现 undefined');
  // 不通过时必须给出下一步，否则用户只知道「坏了」却不知道怎么办
  if (cur.ok === false) {
    assert.equal(typeof cur.hint, 'string');
    assert.ok(cur.hint.length > 0, '不通过时必须给 hint');
  }
}
console.log('ok   默认读当前进程的契约（不要求测试机必须是修复版）');
