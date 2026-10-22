/**
 * DSH ⇄ Hark 消息协议（纯函数，无副作用，便于测试）
 *
 * 发出：
 *   [DSH#<id>] <mode>
 *   ...正文...
 *   [/DSH#<id>]
 * Hark 回复的最后一行以  [[DSH-END#<id>]]  结束。
 * 注意：发出的消息里绝不能出现完整的结束标记字面量，否则会被自己的消息误判为“已回复”。
 */

export const MODES = ['plan', 'review', 'chat'];

export function newRequestId() {
  const t = Date.now().toString(36).slice(-5);
  const r = Math.random().toString(36).slice(2, 6);
  return `${t}${r}`;
}

export const startTag = (id) => `[DSH#${id}]`;
export const footTag = (id) => `[/DSH#${id}]`;
export const endTag = (id) => `[[DSH-END#${id}]]`;

const MODE_HINT = {
  plan: '请求：请为以下需求写实施方案（可拆给多个子代理并行的任务清单）。',
  review: '请求：请审查以下代码/diff，按严重程度列出问题并给出结论。',
  chat: '请求：普通提问。',
};

/** 组装发给 Hark 的消息 */
export function buildMessage(id, mode, body) {
  const m = MODES.includes(mode) ? mode : 'chat';
  const text = String(body ?? '').trim();
  if (text.includes(endTag(id))) throw new Error('正文中不能包含结束标记');
  if (text.includes(footTag(id))) throw new Error('正文中不能包含请求结束标记');
  return [
    `${startTag(id)} ${m}`,
    MODE_HINT[m],
    '（来自 dsh-hark-bridge 自动化；回复完毕请按 DSH 协议在末尾附结束标记）',
    '',
    text,
    footTag(id),
  ].join('\n');
}

/**
 * 规则说明的版本号。改了 buildRulesBody 的内容就加 1，
 * 用户下次调用会自动重发一遍新规则。
 */
export const RULES_VERSION = 1;

/**
 * 首次连接时发给 Hark 的规则说明。
 *
 * 关键约束：这里只能用 <编号> 这种占位符，绝不能拼出真实结束标记的字面量。
 * 否则规则文本自己就会被 extractReply 认成「Hark 已经回复完了」。
 * 占位符里是中文尖括号 + 「编号」，不可能匹配到真实 id（[a-z0-9]{6,12}）。
 */
export function buildRulesBody() {
  return [
    '接下来我会用固定格式给你发消息，先把规则说清楚，之后不再重复。',
    '',
    '## 我的消息格式',
    '',
    '```',
    '[DSH#<编号>] <plan|review|chat>',
    '（一行说明：这次要方案 / 要审查 / 普通提问）',
    '',
    '...正文...',
    '[/DSH#<编号>]',
    '```',
    '',
    '`<编号>` 是每次请求随机生成的短字符串，用来区分不同请求。',
    '',
    '## 你的回复要求（重要）',
    '',
    '1. 正常写你的回复内容，格式随意（Markdown 可以用）。',
    '2. **回复的最后必须单独一行**写结束标记：',
    '',
    '```',
    '[[DSH-END#<同一个编号>]]',
    '```',
    '',
    '3. 编号必须和我这次发的完全一致，不能改、不能省。',
    '4. 结束标记之后不要再写任何内容——我只读它前面的部分。',
    '5. 结束标记只写一次，不要写在正文中间。没有这个标记，我会一直等到超时，你的回复就作废了。',
    '',
    '## 一条注意事项',
    '',
    '如果要在回复里举例说明上面的格式，请用 `<编号>` 占位，不要写成真实编号的样子，否则会被我误认成一条真实回复。',
    '',
    '现在请回复一行「规则已收到」，并附上本次的结束标记。之后我们开始正式协作。',
  ].join('\n');
}

/**
 * 从整页文本中提取 Hark 的回复。
 *
 * 定位方式：找**第一次**出现的 [/DSH#id]（即我们自己消息的结尾），它后面就是 Hark 的回复。
 * 用 indexOf 而不是 lastIndexOf —— Hark 常在回复末尾再补一个 [/DSH#id]，
 * 用最后一次会把回复区间吃空、永远判定「未完成」。
 *
 * 结束标记接受两种写法，因为实测 Hark 用的是后者：
 *   1. [[DSH-END#id]]  —— 协议约定的标准写法
 *   2. [/DSH#id]       —— Hark 实际最常用的写法
 *
 * @returns {{ status: 'not-sent' | 'pending' | 'done', reply: string }}
 */
export function extractReply(pageText, id) {
  const text = String(pageText ?? '');
  const foot = footTag(id);
  const footAt = text.indexOf(foot);
  if (footAt < 0) return { status: 'not-sent', reply: '' };
  const after = text.slice(footAt + foot.length);
  let endAt = after.indexOf(endTag(id));
  if (endAt < 0) endAt = after.indexOf(foot);
  if (endAt < 0) return { status: 'pending', reply: cleanup(after) };
  return { status: 'done', reply: cleanup(after.slice(0, endAt)) };
}

function cleanup(s) {
  // 正文里收掉行尾空白、把连续空行压成 1 个；
  // 但 ``` / ~~~ 围栏代码块内部必须原样保留 —— 里面连续空行是内容的一部分，
  // 压掉会把代码粘在一起，也会把 YAML / 缩进结构的层次改坏。
  const out = [];
  let inFence = false;
  let fenceChar = '';
  let blankRun = 0;
  for (const raw of s.replace(/\r/g, '').split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (marker) {
      const c = marker[1][0];
      if (!inFence) { inFence = true; fenceChar = c; }
      else if (c === fenceChar) { inFence = false; fenceChar = ''; }
      out.push(raw.replace(/[ \t]+$/, ''));
      blankRun = 0;
      continue;
    }
    if (inFence) { out.push(raw); continue; }
    const line = raw.replace(/[ \t]+$/, '');
    if (line === '') {
      if (++blankRun <= 1) out.push('');
    } else {
      blankRun = 0;
      out.push(line);
    }
  }
  return out.join('\n').trim();
}
