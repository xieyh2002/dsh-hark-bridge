/**
 * 用假的 ego 通道走一遍完整流程：选页 → 等输入框 → 输入 → 回车 → 等待结束标记
 *
 * 真的 ego 由 test/e2e-live.mjs 覆盖；这里只验证 bridge 的协议逻辑
 * （消息拼装、结束标记识别、握手、排队），不依赖任何浏览器。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import store 之前设好：store 在模块顶层就会读一次 dataDir()。
// 不隔离的话，握手记录会写进用户真实的 %LOCALAPPDATA%\dsh-hark-bridge\settings.json。
const TMP_HOME = mkdtempSync(join(tmpdir(), 'dsh-hark-test-'));
process.env.DSH_HARK_BRIDGE_HOME = TMP_HOME;

const { HarkBridge } = await import('../lib/bridge.js');
const { DEFAULT_CONFIG } = await import('../lib/config-schema.js');
const { endTag, footTag, buildRulesBody } = await import('../lib/protocol.js');
const { readOverride } = await import('../lib/store.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从生成的脚本里把 message 抠出来，等价于"真的往输入框里打了这些字" */
function messageOf(script) {
  const m = /"message":("(?:[^"\\]|\\.)*")/.exec(script);
  return m ? JSON.parse(m[1]) : '';
}

/**
 * 假 ego：按真实脚本的约定回传尾部文本。
 *
 * 真实脚本只 emit `{phase:'poll', sent:true, text: <footTag 之后的页面文本>}`
 * （审查意见 B3：整页 innerText 随对话增长会变成 O(n²) 回传）。
 * 页面被渲染成「能看到请求、还没有回复」时 tail 就是请求之后那点空白。
 */
function makeFakeEgo({ replyAfterPolls = 2, reply = '方案：\n1. 加 /export 命令', neverReplies = false } = {}) {
  const state = { typed: '', calls: 0, all: [] };
  const streamScript = async function* (script, { signal } = {}) {
    state.calls += 1;
    state.typed = messageOf(script);
    state.all.push(state.typed);
    const id = (state.typed.match(/\[DSH#([a-z0-9]+)\]/) || [])[1];
    assert.ok(id, '发出去的消息里要带请求 id');
    const foot = footTag(id);
    yield { ok: true, phase: 'open' };
    yield { ok: true, phase: 'sent' };
    for (let i = 0; i < 20; i++) {
      if (signal?.aborted) {
        const e = new Error('已取消');
        e.name = 'AbortError';
        throw e;
      }
      // 完整页面长这样（导航栏在前，然后是我们的请求，之后是 Hark 的回复）
      const page = `导航栏\n${state.typed}\n${!neverReplies && i >= replyAfterPolls ? `${reply}\n${endTag(id)}` : ''}`;
      const at = page.indexOf(foot);
      yield at < 0
        ? { ok: true, phase: 'poll', sent: false }
        : { ok: true, phase: 'poll', sent: true, text: page.slice(at + foot.length) };
      await sleep(20);
    }
  };
  const runScript = async () => ({ ok: true, url: 'https://hark.example/p/1' });
  return { state, streamScript, runScript };
}

const URL1 = 'https://hark.example/p/1';
const baseCfg = { ...DEFAULT_CONFIG, harkUrl: URL1, pollMs: 10, settleMs: 10 };

// 1. 正常往返：首轮先握手，再发正式请求
{
  const ego = makeFakeEgo();
  const bridge = new HarkBridge(() => baseCfg, ego);
  const r = await bridge.ask('plan', '给插件加导出功能');
  assert.equal(r.done, true);
  assert.equal(r.reply, '方案：\n1. 加 /export 命令');

  assert.equal(ego.state.calls, 2, '首次 ask 应该是「握手 + 正式请求」两次');
  assert.ok(ego.state.all[0].includes('你的回复要求'), '第一次发的是规则说明');
  assert.ok(ego.state.all[0].includes('DSH-END'), '规则里要说清结束标记长什么样');
  assert.ok(ego.state.all[1].includes('给插件加导出功能'), '第二次才是真正的正文');
  assert.ok(ego.state.all[1].includes('[DSH#'), '消息要带请求 id');
  assert.ok(!ego.state.all[1].includes(endTag('')), '消息里不能出现结束标记的空壳');
  assert.equal(readOverride().handshakes?.[URL1], 1, '握手完成后要记下来');
}

// 2. 握手只做一次：同一地址第二次 ask 不再重发规则
{
  const ego = makeFakeEgo();
  const cfg2 = { ...baseCfg, harkUrl: 'https://hark.example/p/2' };
  const bridge = new HarkBridge(() => cfg2, ego);
  const a = await bridge.ask('plan', '第一个');   // 握手 + 正式 = 2 次
  assert.equal(ego.state.calls, 2, '第一次应该是「握手 + 正式请求」');
  const b = await bridge.ask('chat', '第二个');  // 只有正式 = 1 次
  assert.notEqual(a.id, b.id, '两次请求的 id 必须不同');
  assert.equal(ego.state.calls, 3, '握手 1 次 + 正式请求 2 次');
  assert.ok(!ego.state.all[2].includes('你的回复要求'), '第二次 ask 不该再发规则');
  assert.ok(ego.state.all[2].includes('第二个'), '第二次 ask 发的就是正文');
}

// 3. 换了 Hark 地址要重新握手
{
  const ego = makeFakeEgo();
  const url3 = 'https://hark.example/p/3';
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: url3 }), ego);
  await bridge.ask('chat', '换个页面');
  assert.equal(ego.state.calls, 2, '新地址要重新握手');
  assert.equal(readOverride().handshakes?.[url3], 1);
}

// 4. 没有设置 harkUrl 时给出可操作的提示，而不是空指针
{
  const ego = makeFakeEgo();
  const bridge = new HarkBridge(() => ({ ...DEFAULT_CONFIG }), ego);
  await assert.rejects(() => bridge.ask('plan', 'x'), (e) => {
    assert.match(e.message, /还没有设置 Hark 地址/);
    assert.match(e.message, /\/hark-url/);
    return true;
  });
  assert.equal(ego.state.calls, 0, '没有地址时不该启动任何请求');
}

// 5. 超长正文在打字之前就被拒
{
  const ego = makeFakeEgo();
  const bridge = new HarkBridge(() => ({ ...baseCfg, maxChars: 50 }), ego);
  await assert.rejects(() => bridge.ask('plan', 'x'.repeat(80)), (e) => {
    assert.match(e.message, /超过上限 50/);
    return true;
  });
  assert.equal(ego.state.calls, 0, '被拒的请求不该启动浏览器');
}

// 6. 握手失败不能挡住正式请求（Hark 可能早就学会规则了）
{
  let call = 0;
  const ego = makeFakeEgo();
  const flaky = {
    ...ego,
    streamScript: async function* (script, opts) {
      call += 1;
      if (call === 1) {
        const e = new Error('ego 调用意外结束（exit 1）');
        e.name = 'EgoStageError';
        throw e;
      }
      yield* ego.streamScript(script, opts);
    },
  };
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/9' }), flaky);
  const r = await bridge.ask('chat', '握手挂了也要能发');
  assert.equal(r.done, true);
  assert.ok(r.reply.includes('方案'));
}

// 7. 规则文本自身不能撞上结束标记（否则会被自己判成"已回复"）
{
  const body = buildRulesBody();
  const id = 'abc123';
  const full = `[DSH#${id}] chat\n${body}\n${footTag(id)}`;
  assert.ok(!full.includes(endTag(id)), '拼好的消息里不能出现真实结束标记');
  // 规则正文里不能出现「像真 id」的请求头，否则 Hark 会照抄出第二个请求头
  assert.ok(!body.includes(`[DSH#${id}]`), '规则正文里不能出现真实 id 的请求头');
  // 整条消息里 id 只应出现在请求头和结尾标记两处（正文里一次都不能有）
  const hits = full.split(`[DSH#${id}]`).length - 1;
  assert.equal(hits, 1, `id 只该出现在请求头一处，实际 ${hits} 处`);
  assert.ok(body.includes('<编号>'), '规则里要用占位符代替真实编号');
}

rmSync(TMP_HOME, { recursive: true, force: true });
console.log('bridge mock tests passed');
process.exit(0);
