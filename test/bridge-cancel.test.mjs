/**
 * 取消与超时语义：两者都必须抛出，不能把半截回复当成功结果返回。
 *
 * 用假的 ego 通道复现两种失败：Hark 一直不给结束标记（超时），
 * 以及调用方中途按了停止（取消）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 和 bridge-mock 一样隔离 store，否则握手记录会写进用户真实配置。
const TMP_HOME = mkdtempSync(join(tmpdir(), 'dsh-hark-cancel-'));
process.env.DSH_HARK_BRIDGE_HOME = TMP_HOME;

const { HarkBridge } = await import('../lib/bridge.js');
const { DEFAULT_CONFIG } = await import('../lib/config-schema.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function messageOf(script) {
  const m = /"message":("(?:[^"\\]|\\.)*")/.exec(script);
  return m ? JSON.parse(m[1]) : '';
}

/** 页面永远停在"已发送、未回复" —— 没有结束标记 */
function stuckEgo(state = { typed: '', calls: 0 }) {
  return {
    state,
    async *streamScript(script, { signal } = {}) {
      state.calls += 1;
      state.typed = messageOf(script);
      yield { ok: true, phase: 'open' };
      yield { ok: true, phase: 'sent' };
      while (true) {
        if (signal?.aborted) {
          const e = new Error(signal.reason?.message || '已取消');
          e.name = 'AbortError';
          throw e;
        }
        // 页面在（pageLen > 0），请求也发出去了，只是尾部还没有回复。
        yield { ok: true, phase: 'poll', sent: true, text: '', pageLen: 120 };
        await sleep(20);
      }
    },
    runScript: async () => ({ ok: true, url: 'https://hark.example/p/1' }),
  };
}

// 1. 超时必须抛错，不能返回 done:false 的半截结果
{
  const ego = stuckEgo();
  const bridge = new HarkBridge(
    () => ({ ...DEFAULT_CONFIG, harkUrl: 'https://hark.example/p/1', timeoutMin: 0, pollMs: 10 }),
    ego,
  );
  await assert.rejects(() => bridge.ask('plan', '写方案'), (e) => {
    assert.equal(e.name, 'HarkTimeoutError');
    assert.match(e.message, /没有给出结束标记/);
    assert.match(e.message, /不能当作结论使用/);
    return true;
  });
}

// 2. signal 已 abort：立刻拒绝，一个字节都不该往页面上打
{
  const ego = stuckEgo();
  const bridge = new HarkBridge(
    () => ({ ...DEFAULT_CONFIG, harkUrl: 'https://hark.example/p/1', pollMs: 10 }),
    ego,
  );
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => bridge.ask('plan', '不该发出去', { signal: ac.signal }), (e) => e.name === 'AbortError');
  await sleep(200);
  assert.equal(ego.state.typed, '', 'abort 之后不应再往输入框打字');
  assert.equal(ego.state.calls, 0, 'abort 之后不该启动浏览器');
}

// 3. 轮询中途 abort：及时返回，不等满 timeoutMin
{
  const ego = stuckEgo();
  const bridge = new HarkBridge(
    () => ({ ...DEFAULT_CONFIG, harkUrl: 'https://hark.example/p/1', timeoutMin: 5, pollMs: 10 }),
    ego,
  );
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(
    () => bridge.ask('plan', '中途取消', { signal: ac.signal }),
    (e) => e.name === 'AbortError',
  );
  const spent = Date.now() - t0;
  assert.ok(spent < 3000, `取消应尽快生效，实际耗时 ${spent}ms`);
}

// 4. 找不到输入框（未登录）要报清晰的错，而不是干等到超时
{
  const state = { calls: 0 };
  const ego = {
    state,
    async *streamScript() {
      state.calls += 1;
      yield { ok: true, phase: 'open' };
      const e = new Error('ego 脚本中止于阶段 focus');
      e.name = 'EgoStageError';
      e.stage = 'focus';
      throw e;
    },
    runScript: async () => ({ ok: true }),
  };
  const bridge = new HarkBridge(
    () => ({ ...DEFAULT_CONFIG, harkUrl: 'https://hark.example/p/1', pollMs: 10 }),
    ego,
  );
  await assert.rejects(() => bridge.ask('plan', 'x'), (e) => {
    assert.equal(e.name, 'HarkLoginError');
    assert.match(e.message, /找不到 Hark 输入框/);
    assert.match(e.message, /登录/);
    return true;
  });
}

rmSync(TMP_HOME, { recursive: true, force: true });
console.log('bridge cancel/timeout tests passed');
process.exit(0);
