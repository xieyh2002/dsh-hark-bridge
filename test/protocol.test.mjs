import assert from 'node:assert/strict';
import { buildMessage, extractReply, endTag, footTag, startTag, newRequestId } from '../lib/protocol.js';

const id = newRequestId();
assert.match(id, /^[a-z0-9]{6,12}$/);

const msg = buildMessage(id, 'plan', '给插件加一个导出功能');
assert.ok(msg.startsWith(`${startTag(id)} plan`));
assert.ok(msg.trimEnd().endsWith(footTag(id)));
assert.ok(!msg.includes(endTag(id)), '发出的消息不能包含结束标记');

// 三种模式都要文件，但措辞不同（0.11）：plan/review 一律走文件，chat 有字数门槛。
{
  const plan = buildMessage(id, 'plan', 'x');
  const review = buildMessage(id, 'review', 'x');
  const chat = buildMessage(id, 'chat', 'x');
  assert.match(plan, /请把完整方案写成 \.md 文件/, 'plan 要一律要文件');
  assert.match(review, /请把完整审查意见写成 \.md 文件/, 'review 要一律要文件');
  assert.match(chat, /超过 300 字左右/, 'chat 用字数门槛');
  assert.ok(!chat.includes('请把完整方案写成'), 'chat 不该照搬 plan 的措辞');
  // 每一条都得说清「做不到要讲」，否则插件分不清「这次不需要文件」和「它忘了」。
  assert.match(plan, /无法生成文件/);
  assert.match(chat, /一两句话能说清的直接回正文/);
}

// 还没发出
assert.equal(extractReply('hello', id).status, 'not-sent');

// 已发出，回复进行中
const page1 = `侧边栏\n${msg}\nHark 正在输入…\n第一步：`;
const r1 = extractReply(page1, id);
assert.equal(r1.status, 'pending');
assert.ok(r1.reply.includes('第一步'));

// 回复完成；结束标记之后的 UI 文本应被忽略
const page2 = `${msg}\n方案如下\n\n\n\n1. 拆分模块\n${endTag(id)}\n输入框占位文字`;
const r2 = extractReply(page2, id);
assert.equal(r2.status, 'done');
assert.equal(r2.reply, '方案如下\n\n1. 拆分模块');

// 同一页面里有旧请求，不应串号
const other = newRequestId() + 'x';
const page3 = `${buildMessage(other, 'chat', 'old')}\n旧回复\n${endTag(other)}\n${msg}\n新回复中`;
assert.equal(extractReply(page3, id).status, 'pending');

assert.throws(() => buildMessage(id, 'chat', `x ${endTag(id)}`));

// 代码块内部的连续空行必须原样保留（压掉会把代码粘在一起）
const fencePage = `${msg}\n示例：\n\`\`\`js\nfunction a() {}\n\n\nfunction b() {}\n\`\`\`\n${endTag(id)}`;
assert.equal(
  extractReply(fencePage, id).reply,
  '示例：\n```js\nfunction a() {}\n\n\nfunction b() {}\n```',
);

// 围栏外的连续空行压成一个
assert.equal(extractReply(`${msg}\n第一段\n\n\n\n第二段\n${endTag(id)}`, id).reply, '第一段\n\n第二段');

// 行尾空白被清掉
assert.equal(extractReply(`${msg}\n第一段   \n第二段\t\n${endTag(id)}`, id).reply, '第一段\n第二段');

// 空回复不算完成：发送瞬间请求被渲染两次（输入框 + 气泡）
const dup = `${msg}\n${msg}\n`;
assert.deepEqual(extractReply(dup, id), { status: 'pending', reply: '' });
assert.equal(extractReply(`${msg}\n${msg.slice(0, 20)}`, id).status, 'pending');
assert.equal(extractReply(`${msg}\n\n${footTag(id)}\n`, id).status, 'pending');
// 双份渲染后 Hark 真正回复完，仍能拿到正文
const dupDone = `${msg}\n${msg}\n方案A\n${endTag(id)}`;
const rd = extractReply(dupDone, id);
assert.equal(rd.status, 'done');
assert.equal(rd.reply, '方案A');

// 标记出现在行内（正文里引用）不算结束
const inline = `${msg}\n你消息结尾的 ${footTag(id)} 我看到了，方案如下：\n1. 拆分`;
assert.equal(extractReply(inline, id).status, 'pending');
const inline2 = `${msg}\n结束标记写法是 ${endTag(id)} 这样\n继续写`;
assert.equal(extractReply(inline2, id).status, 'pending');
// `[/DSH#id]` 不再是结束标记：它可能是 Hark 在正文里引用请求，
// 拿它当结束会把后半截回复丢掉、却交给上游一个“完整结论”（审查意见 B1）。
const r5 = extractReply(`${inline}\n${footTag(id)}`, id);
assert.equal(r5.status, 'pending', 'footTag 不能当结束标记');
assert.ok(r5.reply.includes('1. 拆分'));

// 需要兼容只写 footTag 的旧对话时，显式开关打开才认。
assert.equal(extractReply(`${msg}\n方案\n${footTag(id)}`, id).status, 'pending');
assert.deepEqual(
  extractReply(`${msg}\n方案\n${footTag(id)}`, id, { acceptFootFallback: true }),
  { status: 'done', reply: '方案' },
);

// Markdown 把换行并成空格：标记跟在最后一句后面也要认
const soft = extractReply(`${msg}\n方案如下：拆两个模块 ${endTag(id)}\n输入框`, id);
assert.deepEqual(soft, { status: 'done', reply: '方案如下：拆两个模块' });

// 单独成行允许前后空白、CRLF
assert.equal(extractReply(`${msg}\r\n好的\r\n   ${endTag(id)}  \r\n`, id).status, 'done');

// --- B1 回归：结束标记只认行尾的 endTag，绝不把它当成"截断点"之外的东西 ---

// 正文中间出现 footTag 不该截断
assert.equal(
  extractReply(`${msg}\n第一段\n${footTag(id)} 这样写是不对的\n第二段\n${endTag(id)}`, id).reply,
  `第一段\n${footTag(id)} 这样写是不对的\n第二段`,
);

// 正文里引用 endTag（后面还有字）不算结束
assert.equal(
  extractReply(`${msg}\n写法是 ${endTag(id)} 这样\n继续\n${endTag(id)}`, id).reply,
  `写法是 ${endTag(id)} 这样\n继续`,
);

// 多个 endTag 取最后一个（前面的可能被后续正文破坏）
assert.equal(
  extractReply(`${msg}\n第一段\n${endTag(id)}\n第二段\n${endTag(id)}`, id).reply,
  `第一段\n${endTag(id)}\n第二段`,
);

// 页面被渲染成"以请求开头但被截断"的引用预览：能看到请求却定位不到回复区间，
// 这是还在生成，不是没发出。
assert.equal(extractReply(`${msg}\n${startTag(id)} chat\n（截断）`, id).status, 'pending');

console.log('protocol tests passed');
