// 等回复状态机的表驱动测试：喂真实出现过的观测值序列，看它怎么走。
//
// 这个文件的价值在于「不碰浏览器」——每条用例都是几毫秒，可以放心把边界堆满。

import assert from 'node:assert/strict';
import { EMPTY_PAGE_MS, SEND_GRACE_MS, finishState, initialState, stepEvent, stepPoll } from '../lib/ask-machine.js';
import { footTag, endTag } from '../lib/protocol.js';

const ID = 'abc12345';
const FOOT = footTag(ID);
const END = endTag(ID);

function cfg(over = {}) {
  return {
    id: ID,
    settleMs: 100,
    attachGraceMs: 200,
    wantsFile: true,
    sendDeadline: 30_000,
    deadline: 10 * 60_000,
    uploadNames: [],
    ...over,
  };
}

// 一条完整的回复：带结束标记，正文是「方案」
function replyObs(at, over = {}) {
  return {
    phase: 'poll',
    sent: true,
    same: false,
    text: `\n方案正文\n${END}\n`,
    pageLen: 5000,
    mdCards: 0,
    anchored: true,
    mdTotal: 0,
    at,
    ...over,
  };
}

// 还没回复：只有请求，没有结束标记
function waitingObs(at, over = {}) {
  return { phase: 'poll', sent: true, same: false, text: '\n（还在想）\n', pageLen: 5000, at, ...over };
}

console.log('ask machine tests');

// 1. 正常往返：看到结束标记 → settle 满足 → finish
{
  let s = initialState();
  let r = stepPoll(s, waitingObs(1000), cfg());
  assert.equal(r.action, 'continue', '还没回复时继续等');
  assert.equal(r.state.sentSeen, true, '看到请求就算已发送');

  r = stepPoll(r.state, replyObs(2000), cfg());
  assert.equal(r.action, 'continue', '第一次看到结束标记只记时刻');
  assert.equal(r.state.doneAt, 2000);

  r = stepPoll(r.state, replyObs(5000, { mdCards: 1 }), cfg());
  assert.equal(r.action, 'finish', 'settle 满足就结束');
  assert.equal(r.state.settled.reply, '方案正文');
  assert.equal(r.state.settled.done, true);

  const f = finishState(r.state);
  assert.equal(f.action, 'finish');
  assert.equal(f.result.reply, '方案正文');
}

// 2. same:true 的心跳不能把结束标记抹掉，否则 settle 永远等不满
{
  let s = initialState();
  let r = stepPoll(s, replyObs(2000), cfg());
  // 中间插一堆「尾部没变」的心跳
  for (let t = 2100; t <= 3000; t += 100) {
    r = stepPoll(r.state, { phase: 'poll', same: true, pageLen: 5000, at: t }, cfg());
  }
  assert.equal(r.action, 'finish', '心跳不应打断 settle');
  assert.equal(r.state.settled.reply, '方案正文');
}

// 3. 结束标记先出现又消失（Hark 在补写）：定稿作废，回到等
{
  let s = initialState();
  let r = stepPoll(s, replyObs(2000), cfg());
  assert.ok(r.state.doneAt, '先记下定稿时刻');
  r = stepPoll(r.state, { ...waitingObs(2100) }, cfg());
  assert.equal(r.state.doneAt, 0, '标记不见了要清零');
  assert.equal(r.state.settled, null, '之前的定稿要作废');
  assert.equal(r.action, 'continue');
}

// 4. 卡片宽限期：定稿了但还没有卡片 → 继续等，等到了就立刻结束
{
  let s = initialState();
  let r = stepPoll(s, replyObs(2000, { mdCards: 0 }), cfg({ attachGraceMs: 200 }));
  assert.equal(r.action, 'continue', '第一次看到结束标记只记时刻');
  assert.equal(r.state.settled, null, 'settle 还没满足，不能算定稿');

  r = stepPoll(r.state, replyObs(2100, { mdCards: 0 }), cfg({ attachGraceMs: 200 }));
  assert.equal(r.action, 'continue', '计划/审查模式要等卡片');
  assert.ok(r.state.settled, '文字已定稿这件事要记住');
  assert.equal(r.state.graceUntil, 2300, '宽限期从定稿时刻（settle 满足那一轮）起算');

  // 宽限期内卡片出现 → 立刻结束，不必等满
  r = stepPoll(r.state, replyObs(2150, { mdCards: 1 }), cfg({ attachGraceMs: 200 }));
  assert.equal(r.action, 'finish');
  assert.equal(r.state.settled.mdCards, 1);
}

// 5. 宽限期到了还是没有卡片 → 一样算成功（只是没有附件）
{
  let s = initialState();
  let r = stepPoll(s, replyObs(2000), cfg({ attachGraceMs: 200 }));
  r = stepPoll(r.state, replyObs(2100), cfg({ attachGraceMs: 200 }));
  assert.equal(r.action, 'continue', '宽限期内继续等');
  r = stepPoll(r.state, replyObs(2300), cfg({ attachGraceMs: 200 }));
  assert.equal(r.action, 'finish', '宽限期满就结束');
  assert.equal(r.state.settled.mdCards, 0);
  const f = finishState(r.state);
  assert.equal(f.action, 'finish', '没有卡片也是成功');
}

// 6. chat 用 'long'：短回复不等，长回复照样等
//
// 为什么 chat 不能一律等：Hark 被要求「回答超过 300 字也写成 .md」，于是每个
// 一句「收到」的闲聊都会白站 attachGraceMs（默认 8 秒），用户会觉得插件卡住。
// 但也不能一律不等——chat 的回答真的写长了，那份 .md 才是原文。
{
  let s = initialState();
  let r = stepPoll(s, replyObs(2000, { mdCards: 0 }), cfg({ wantsFile: 'long', attachGraceMs: 5000 }));
  r = stepPoll(r.state, replyObs(2100, { mdCards: 0 }), cfg({ wantsFile: 'long', attachGraceMs: 5000 }));
  assert.equal(r.action, 'finish', '短回复的 chat 不等卡片');
  assert.equal(r.state.settled.reply, '方案正文');
}
{
  // 同样的流程，但正文超过长回复门槛
  const long = `${'\n很长的回答正文，要让它超过门槛。'.repeat(20)}\n${END}\n`;
  const obs = (at) => ({ ...replyObs(at, { mdCards: 0 }), text: long });
  let s = initialState();
  let r = stepPoll(s, obs(2000), cfg({ wantsFile: 'long', longReplyChars: 100, attachGraceMs: 5000 }));
  r = stepPoll(r.state, obs(2100), cfg({ wantsFile: 'long', longReplyChars: 100, attachGraceMs: 5000 }));
  assert.equal(r.action, 'continue', '长回复的 chat 要为卡片等一会儿');
  // 宽限期内卡片出现就立刻结束
  r = stepPoll(r.state, { ...obs(2500), mdCards: 1 }, cfg({ wantsFile: 'long', longReplyChars: 100, attachGraceMs: 5000 }));
  assert.equal(r.action, 'finish');
  assert.equal(r.state.settled.mdCards, 1);
}
{
  // longReplyChars: 0 表示「chat 也一律等」
  let s = initialState();
  let r = stepPoll(s, replyObs(2000, { mdCards: 0 }), cfg({ wantsFile: 'long', longReplyChars: 0, attachGraceMs: 5000 }));
  r = stepPoll(r.state, replyObs(2100, { mdCards: 0 }), cfg({ wantsFile: 'long', longReplyChars: 0, attachGraceMs: 5000 }));
  assert.equal(r.action, 'continue', '门槛设 0 就是一律等');
}

// 6b. wantsFile: false 一律不等（关掉文件通道时的行为）
{
  let s = initialState();
  let r = stepPoll(s, replyObs(2000, { mdCards: 0 }), cfg({ wantsFile: false, attachGraceMs: 5000 }));
  r = stepPoll(r.state, replyObs(2100, { mdCards: 0 }), cfg({ wantsFile: false, attachGraceMs: 5000 }));
  assert.equal(r.action, 'finish', '关掉时不等卡片');
}

// 7. 没定位到回复气泡时不宽限（拿不到锚点，等也没有意义）
{
  let s = initialState();
  let r = stepPoll(s, replyObs(2000, { anchored: false }), cfg({ attachGraceMs: 5000 }));
  r = stepPoll(r.state, replyObs(2100, { anchored: false }), cfg({ attachGraceMs: 5000 }));
  assert.equal(r.action, 'finish', '没有锚点就不等卡片');
}

// 8. mdCards 取历史最大值：settle 期间页面重渲染把卡片短暂摘掉不能算丢
{
  let s = initialState();
  let r = stepPoll(s, replyObs(2000, { mdCards: 2 }), cfg({ attachGraceMs: 200 }));
  r = stepPoll(r.state, replyObs(2100, { mdCards: 2 }), cfg({ attachGraceMs: 200 }));
  assert.equal(r.action, 'finish', '有卡片就直接结束');
  r = stepPoll(r.state, replyObs(2200, { mdCards: 0 }), cfg({ attachGraceMs: 200 }));
  assert.equal(r.state.mdCards, 2, '取到过的最大值即是结论');
}

// 9. 发送后一直看不到请求 → 30 秒报发送失败，而不是等到整体超时
{
  const s = initialState();
  const r = stepPoll(s, { phase: 'poll', sent: false, pageLen: 5000, at: SEND_GRACE_MS + 1 }, cfg());
  assert.equal(r.action, 'fail');
  assert.equal(r.error.kind, 'not-sent');
  assert.match(r.error.message, /30 秒内页面上没出现已发送的消息/);
}

// 10. 页面被导航走（整页文本为空）→ 超过阈值报页面丢失，不混成超时
{
  let s = initialState();
  let r = stepPoll(s, waitingObs(1000), cfg());
  r = stepPoll(r.state, { phase: 'poll', sent: true, pageLen: 0, at: 2000 }, cfg());
  assert.equal(r.action, 'continue', '刚开始空不算丢，可能只是渲染中');
  assert.equal(r.state.emptySince, 2000, '记下开始空的时刻');
  r = stepPoll(r.state, { phase: 'poll', sent: true, pageLen: 0, at: 2000 + EMPTY_PAGE_MS + 1 }, cfg());
  assert.equal(r.action, 'fail');
  assert.equal(r.error.kind, 'page-lost');
}

// 11. 页面空一下又恢复 → 不能误报
{
  let s = initialState();
  let r = stepPoll(s, waitingObs(1000), cfg());
  r = stepPoll(r.state, { phase: 'poll', sent: true, pageLen: 0, at: 2000 }, cfg());
  r = stepPoll(r.state, waitingObs(3000), cfg());
  assert.equal(r.state.emptySince, 0, '恢复之后计数要清零');
  assert.equal(r.action, 'continue');
}

// 12. 整体超时：没等到结束标记 → finishState 报 timeout，且带上半截内容
{
  const s = initialState();
  const s2 = stepPoll(s, { phase: 'poll', sent: true, text: '\n写了一半\n', pageLen: 5000, at: 1000 }, cfg()).state;
  const f = finishState(s2);
  assert.equal(f.action, 'fail');
  assert.equal(f.error.kind, 'timeout');
  assert.equal(f.error.partial, '写了一半', '半截内容要带给调用方');
}

// 13. 宽限期里 poll 流提前结束（假 ego 只推有限次）→ 仍算成功，绝不报超时
{
  let s = initialState();
  let r = stepPoll(s, replyObs(2000), cfg({ attachGraceMs: 60_000 }));
  assert.equal(r.action, 'continue', '第一次看到结束标记只记时刻');
  r = stepPoll(r.state, replyObs(2100), cfg({ attachGraceMs: 60_000 }));
  assert.equal(r.action, 'continue', '还在宽限期');
  assert.ok(r.state.settled, '文字已定稿要记下来');
  const f = finishState(r.state, { finished: null });
  assert.equal(f.action, 'finish', 'settled 也算成功');
  assert.equal(f.result.reply, '方案正文');
}

// 14. 事件折算：attach 与 attach-missing
{
  let s = initialState();
  s = stepEvent(s, { phase: 'attach', ready: true });
  assert.equal(s.attachReady, true, '附件就绪要记下来');

  const s0 = initialState();
  const s1 = stepEvent(s0, { phase: 'attach', ok: false });
  assert.equal(s1, s0, '失败型 attach 不归这里管');

  let s2 = stepEvent(initialState(), { phase: 'attach-missing', names: ['a.js', 'b.md'] });
  assert.match(s2.warnings[0], /发送后校验未在气泡里找到附件：a\.js、b\.md/);
  const n = s2.warnings.length;
  s2 = stepEvent(s2, { phase: 'attach-missing', names: ['c.js'] });
  assert.equal(s2.warnings.length, n, '缺失清单只提醒一次');

  assert.equal(stepEvent(initialState(), { phase: 'sent' }), null, 'sent 与回复判定无关');
  assert.equal(stepEvent(initialState(), { phase: 'attachment', ok: true }), null, '下载事件与回复判定无关');
}

// 15. uploadNames 要带进 settled：下载时排掉自己刚传的文件
{
  let s = initialState();
  let r = stepPoll(s, replyObs(2000), cfg({ uploadNames: ['README.md'] }));
  r = stepPoll(r.state, replyObs(2100, { mdCards: 1 }), cfg({ uploadNames: ['README.md'] }));
  assert.equal(r.action, 'finish');
  assert.deepEqual(r.state.settled.uploadNames, ['README.md']);
}

// 16. 状态对象本身不可变，但 warnings 数组要和调用方共享同一个引用
//     （调用方在 ask 之外也会往里写告警，换新数组会让那些告警传不到返回值上）
{
  const shared = ['原有一条'];
  const s = initialState({ warnings: shared });
  assert.equal(s.warnings, shared, 'warnings 必须是同一个数组，不能复制');
  const before = JSON.stringify({ ...s, warnings: shared.length });
  const r = stepPoll(s, replyObs(2000), cfg());
  stepEvent(s, { phase: 'attach', ready: true });
  assert.equal(s.attachReady, false, '原 state 不能被就地改掉');
  assert.notEqual(r.state, s, '要返回新对象');
  assert.equal(shared[0], '原有一条', 'warnings 内容不丢');
}

// 17. settled 的形状要完整：id 少了下载附件就锚不上（0.9.0 拆分时真踩过）
{
  let s = initialState();
  let r = stepPoll(s, replyObs(2000, { mdCards: 1 }), cfg());
  r = stepPoll(r.state, replyObs(2100, { mdCards: 1 }), cfg());
  assert.equal(r.action, 'finish');

  const settled = r.state.settled;
  // 逐项点名而不是深比较：深比较会因为 warnings 数组引用相同而看不出漏字段。
  assert.equal(settled.id, ID, 'settled.id 必须带上——下载附件要用它拼结束标记');
  assert.equal(settled.done, true);
  assert.equal(settled.reply, '方案正文');
  assert.equal(typeof settled.attachReady, 'boolean');
  assert.equal(typeof settled.mdCards, 'number');
  assert.equal(typeof settled.anchored, 'boolean');
  assert.equal(typeof settled.mdTotal, 'number');
  assert.ok(Array.isArray(settled.warnings));
  assert.ok(Array.isArray(settled.uploadNames));
}

console.log('ask machine tests passed');
