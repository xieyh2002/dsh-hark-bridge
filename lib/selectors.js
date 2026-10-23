/**
 * Hark 页面上的锚点集中在这里。
 *
 * 为什么单独抽出来：这些字符串是插件和 Hark 前端之间唯一的契约，而它是最脆的一环。
 * 早先它们散在 `lib/bridge.js` 的六个模板字符串里，同一个 `[data-testid=message-bubble]`
 * 出现四次，改一处漏三处；更要紧的是**文案写死成中文**——`/发送/` 匹配不上英文界面的
 * "Send message"，于是附件永远判不就绪、带附件的请求必然超时，而报错只说「附件没就绪」，
 * 用户完全看不出是语言问题。
 *
 * 这里的规则：
 * 1. 优先 `data-testid`——Hark 换文案时它不变，只有改版才会动。
 * 2. 文案类锚点一律中英文双匹配，别假设用户界面是中文。
 * 3. 全都允许配置覆盖（`inputSelector` / `sendSelector` / `attachmentSelector`），
 *    这样 Hark 真改版了，用户不用等我们发新版。
 */

/** 结构锚点：优先用 data-testid，Hark 改文案时它不动 */
export const SEL = {
  bubble: '[data-testid=message-bubble]',
  sendButton: 'button[data-testid=send-button]',
  fileInput: 'input[type=file]',
  /** 附件卡片：Hark 用 button + aria-label，但换成一个 <a> 也很自然，所以两个都试 */
  card: 'button[aria-label], a[aria-label], [role=button][aria-label]',
  /** 输入框：textarea / contenteditable / role=textbox 三选一 */
  input: 'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
};

/**
 * 文案锚点。全部中英双语，顺序不影响结果。
 *
 * 加语言时只改这里：新增一个 `send` 的正则分支即可，不用去翻模板字符串。
 */
export const TEXT = {
  /**
   * 发送按钮的 aria-label：空输入时它是「开始听写」，所以必须确认是「发送」才敢按。
   *
   * 英文必须带词边界：不带的话 `/send/i` 会命中德语 "Absenden"、法语 "Envoyer"
   * 里的片段，把「不是发送」的按钮当成发送键按下去——这类误判比认不出来更糟，
   * 因为它会静默地按错按钮。中文没有词边界（汉字不算 `\w`），只能直接匹配子串。
   */
  send: /\b(?:send|submit)\b|发送|提交/i,
  /**
   * 语音输入按钮的 aria-label。
   *
   * 实测（Hark 中文界面）：输入框为空时，那个 `button[data-testid=send-button]`
   * 的 aria-label 是「开始听写」，输入文字或挂了附件之后才变成「发送消息」。
   * 所以自检看到「开始听写」不该报失败——那是空输入的正常状态，不是文案不匹配。
   * 认不出来才是真问题，那时才需要用户报给我们。
   */
  dictation: /听写|语音输入|\b(?:start\s+)?dictation\b|^\s*(?:start\s+)?voice/i,
  /** 文件卡片 aria-label 的前缀：「打开 xxx 的预览」/ "Open preview of xxx" */
  previewOpen: /^\s*(?:打开|open)\s+(?:preview\s+(?:of\s+)?)?/i,
  /** 文件卡片 aria-label 的后缀：「…的预览」/ "… preview" */
  previewClose: /\s*(?:的预览|preview)\s*$/i,
  /** 只认 Markdown 附件 */
  markdown: /\.md$/i,
};

/**
 * 从卡片 aria-label 里抠出文件名。
 *
 * 为什么要这么绕：Hark 的 aria-label 形状不固定，实测见过
 * `打开 dsh-hark-bridge-0.8-改进方案.md 的预览`（中文）和
 * `Open preview of plan.md`（英文），还可能只是 `plan.md`。
 * 所以先按「找一段以 .md 结尾的连续字符」这条最稳的规则抠，
 * 抠不到才退回剥前后缀——剥法依赖文案，换个措辞就失效。
 *
 * 注意：这个函数会被 `toString()` 注入到页面里执行，所以**不能引用外部变量**，
 * 参数必须自带（`open`/`close`/`md` 三个正则由调用方传进来）。
 * @param {string} label
 * @param {RegExp} open
 * @param {RegExp} close
 * @param {RegExp} md
 * @returns {string}
 */
export function nameFromLabel(label, open, close, md) {
  const raw = String(label || '').trim();
  if (!raw) return '';
  // 1. 按已知措辞剥前后缀。剥完整体就是个 .md 文件名——这是最可信的答案，
  //    而且它允许文件名里带空格（`打开 a b.js.md 的预览` → `a b.js.md`），
  //    这是抠字符串做不到的。
  //
  //    没剥到东西时（`stripped === raw`）要更严格：只接受「整个 label 就是一个
  //    不带空格的 .md 文件名」。否则 `preview: 仓库审查意见.md` 这种
  //    「一句说明 + 文件名」会被整句当成名字。冒号顺带也挡掉——Windows 文件名
  //    不允许它，出现就说明这句还带着别的话。
  const stripped = raw.replace(open, '').replace(close, '').trim();
  const trimmedAway = stripped !== raw;
  if (stripped && md.test(stripped) && (trimmedAway || !/[\s:]/.test(stripped))) return stripped;
  // 2. 措辞没见过（Hark 换了文案）：从 label 里抠「以 .md 结尾」的一段。
  //    只取不含空格的一段：`查看 方案.md 详情` 要拿到 `方案.md`，
  //    而不是把前面的「查看」一起吞进来。起点也必须落在词边界。
  const hit = /(?:^|\s)([^\s/\\]+?\.md)\b/i.exec(raw);
  if (hit && md.test(hit[1])) return hit[1].trim();
  return stripped;
}
