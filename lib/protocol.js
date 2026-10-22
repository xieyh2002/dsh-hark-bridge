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
    // 每条都写明格式，不依赖首次握手：对话上下文被压缩、或握手没成功时也不会退化成超时。
    // 这里用 <编号> 占位，不是真实 id，所以不会被 extractReply 认成结束标记。
    '（来自 dsh-hark-bridge 自动化。回复的最后请单独一行写 [[DSH-END#<编号>]]，'
      + '<编号> 用本条第一行 [DSH#<编号>] 里的那个编号，不要改）',
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
 * ## 锚点：只认 endTag
 * `[[DSH-END#id]]` 是本协议里唯一可靠的锚点：
 *   - 我们自己发的消息里绝不会出现它（buildMessage 会拒绝，规则文本用占位符）；
 *   - 它只可能由 Hark 在回复结束时写出。
 * 所以拿**最后一个**位于行尾的 endTag 当作结束。
 *
 * 早先的版本把 `[/DSH#id]` 也当结束标记——那会把「Hark 在回复里解释协议、
 * 引用请求、或代码块里恰好有一行以它结尾」当成完成，后半截回复被丢掉，
 * 上层却拿到一个看起来完整的结论。这是最危险的失败模式，所以取消了。
 * 需要兼容老对话时传 `{ acceptFootFallback: true }`，默认关闭。
 *
 * ## 起点：第一个 footTag
 * 回复区间 = 第一个 `[/DSH#id]`（我们自己消息的结尾）到 endTag 之间。
 * 取第一个而不是最后一个：Hark 常会在回复末尾再补一个 `[/DSH#id]`，
 * 用最后一个会把区间吃空。正文里引用 footTag 也不会把起点后移。
 * 页面把请求渲染成两份（输入框 + 气泡、或重复渲染）时，紧跟着的自身副本
 * （以 `[DSH#id]` 开头）会被整段跳过；截断的引用预览里没有 footTag，
 * 循环会安全退出，不会一直 pending。
 *
 * 标记必须在**行尾**（后面只有空白）：Hark 页面按 Markdown 渲染，单个换行
 * 会被并成空格，所以不能要求「独占整行」，否则正常回复会等到超时；
 * 而「写法是 [[DSH-END#id]] 这样」后面还有字，仍然不算结束。
 *
 * @param {string} pageText 页面 innerText
 * @param {string} id 本次请求编号
 * @param {{ acceptFootFallback?: boolean }} [options]
 * @returns {{ status: 'not-sent' | 'pending' | 'done', reply: string }}
 */
export function extractReply(pageText, id, options = {}) {
  const text = String(pageText ?? '').replace(/\r/g, '');
  const foot = footTag(id);
  const end = endTag(id);
  const start = startTag(id);

  // 主路径：以 endTag 为锚。
  const endAt = lastMarkerLine(text, [end]);
  if (endAt >= 0) {
    const region = regionAfterRequest(text.slice(0, endAt), foot, start);
    if (region !== null) {
      const reply = cleanup(region);
      // 回复为空说明这是重复渲染的副本、或 Hark 还没写正文：继续等。
      if (reply) return { status: 'done', reply };
    }
    return { status: 'pending', reply: '' };
  }

  // 兼容路径：只认 [/DSH#id] 的旧对话（默认关闭）。
  if (options.acceptFootFallback) {
    const region = regionAfterRequest(text, foot, start);
    if (region === null) return { status: 'not-sent', reply: '' };
    const at = findMarkerLine(region, [end, foot]);
    if (at >= 0) {
      const reply = cleanup(region.slice(0, at));
      if (reply) return { status: 'done', reply };
    }
    return { status: 'pending', reply: cleanup(at >= 0 ? region.slice(0, at) : region) };
  }

  const head = regionAfterRequest(text, foot, start);
  // 页面上连我们的请求都看不到，才算 not-sent；能看到请求但定位不到回复区间，
  // 是「Hark 还没写完」（例如回复渲染成一段以 [DSH#id] 开头的截断引用预览）。
  if (head === null) return { status: text.includes(foot) ? 'pending' : 'not-sent', reply: '' };
  return { status: 'pending', reply: cleanup(head) };
}

/**
 * 从「我们自己消息的结尾」之后取文本。
 *
 * 找到第一个 foot，跳过紧跟着的自身副本（每跳一次都要重新找 foot，
 * 副本里没有 foot 就返回 null，交给调用方判定）。
 * @returns {string|null} null 表示页面上还看不到我们的请求
 */
function regionAfterRequest(text, foot, start) {
  const f = text.indexOf(foot);
  if (f < 0) return null;
  let rest = text.slice(f + foot.length);
  while (rest.trimStart().startsWith(start)) {
    const t = rest.trimStart();
    const next = t.indexOf(foot);
    if (next < 0) return null;
    rest = t.slice(next + foot.length);
  }
  return rest;
}

/**
 * 在 s 里找第一个「位于行尾」的标记（后面只允许空白），返回标记的下标，找不到返回 -1。
 *
 * 前面还没有任何正文的标记会被跳过：返回第一个「前面已有正文」的候选；
 * 都没有就返回第一个候选。
 */
export function findMarkerLine(s, markers) {
  let first = -1;
  let pos = 0;
  for (const line of s.split('\n')) {
    const t = line.trimEnd();
    for (const m of markers) {
      if (!t.endsWith(m)) continue;
      const at = pos + t.length - m.length;
      if (first < 0) first = at;
      if (s.slice(0, at).trim()) return at;
      break;
    }
    pos += line.length + 1;
  }
  return first;
}

/** 在 s 里找最后一个「位于行尾」的标记，返回标记的下标，找不到返回 -1。 */
export function lastMarkerLine(s, markers) {
  let found = -1;
  let pos = 0;
  for (const line of s.split('\n')) {
    const t = line.trimEnd();
    for (const m of markers) {
      if (!t.endsWith(m)) continue;
      found = pos + t.length - m.length;
      break;
    }
    pos += line.length + 1;
  }
  return found;
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
