import assert from 'node:assert/strict';
import { buildMessage, extractReply, endTag, footTag, startTag, newRequestId } from '../lib/protocol.js';

const id = newRequestId();
assert.match(id, /^[a-z0-9]{6,12}$/);

const msg = buildMessage(id, 'plan', '给插件加一个导出功能');
assert.ok(msg.startsWith(`${startTag(id)} plan`));
assert.ok(msg.trimEnd().endsWith(footTag(id)));
assert.ok(!msg.includes(endTag(id)), '发出的消息不能包含结束标记');

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

console.log('protocol tests passed');
