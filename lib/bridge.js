/**
 * HarkBridge：打开 Hark 网页 → 发送消息 → 等待带结束标记的回复
 *
 * 浏览器层直接用用户自己的 ego（通过 `ego-browser nodejs` 官方通道），
 * 所以登录一次之后一直有效，也不会另开一个没登录的空浏览器。
 *
 * 并发模型有两层（审查意见 S1）：
 *   - 进程内：this.queue 让同一个插件的请求串行，不会两个请求同时往一个输入框打字；
 *   - 跨进程：dataDir 下的 lock 文件。DSH 可能开着多个窗口（甚至多个 profile），
 *     它们各自有自己的 HarkBridge 实例，只靠 this.queue 挡不住。
 *     没有锁的时候两个进程会抢同一个输入框，结果是 A 的正文被 B 的正文覆盖、
 *     两个 id 都等不到结束标记，一起超时。
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AttachError, cleanupStaging, collectAttachments, sha256Of, stageAttachments } from './attach.js';
import { runEgoScript, streamEgoScript } from './ego.js';
import { newRequestId, buildMessage, buildRulesBody, endTag, extractReply, footTag, RULES_VERSION } from './protocol.js';
import { dataDir, readOverride, writeOverride } from './store.js';

const js = (v) => JSON.stringify(v ?? null);

/** 定位输入框并全选其已有内容（insertText 会替换掉选区） */
const FOCUS_INPUT = (selector) => `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled && !el.readOnly; };
  const sel = ${js(selector)} || 'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]';
  const els = [...document.querySelectorAll(sel)].filter(vis);
  if (!els.length) return false;
  els.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
  const el = els[0];
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') { el.select(); }
  else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  window.__dshInput = el;
  return true;
})()`;

const INPUT_LEN = `(() => { const el = window.__dshInput; if (!el || !el.isConnected) return -1;
  return ((el.value ?? el.innerText) || '').trim().length; })()`;

/** 兜底：点击输入框附近的发送按钮 */
const CLICK_SEND = (selector) => `(() => {
  const input = window.__dshInput;
  let btns = ${js(selector)} ? [...document.querySelectorAll(${js(selector)})] : [...document.querySelectorAll('button, [role="button"]')];
  const re = /send|submit|发送|提交/i;
  btns = btns.filter((b) => !b.disabled && b.getBoundingClientRect().width > 0);
  if (!${js(selector)}) btns = btns.filter((b) => re.test([b.getAttribute('aria-label'), b.title, b.textContent, b.type, b.dataset?.testid].join(' ')));
  if (!btns.length) return false;
  if (input) { const ir = input.getBoundingClientRect();
    const d = (b) => { const r = b.getBoundingClientRect(); return Math.hypot(r.left - ir.right, r.top - ir.top); };
    btns.sort((a, b) => d(a) - d(b)); }
  btns[0].click();
  return true;
})()`;

const PAGE_TEXT = `(() => document.body ? document.body.innerText : '')()`;

/**
 * 给「离输入框最近的那个 file input」打标记，返回它的选择器。
 *
 * setInputFiles 只接受选择器或 handle，而选择器一旦写死就会撞上页面上其它
 * file input（头像、导入配置…）。Hark 的附件 input 是隐藏的（offsetWidth=0），
 * 没法按可见性筛，只能按与 composer 的距离排。
 */
const MARK_FILE_INPUT = (selector) => `(() => {
  const prefer = ${js(selector)} ? [...document.querySelectorAll(${js(selector)})] : [];
  const all = prefer.length ? prefer : [...document.querySelectorAll('input[type=file]')];
  if (!all.length) return null;
  const input = (window.__dshInput && window.__dshInput.isConnected)
    ? window.__dshInput
    : [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].find((el) => el.getBoundingClientRect().width > 0);
  let best = all[0];
  if (input) {
    const ir = input.getBoundingClientRect();
    const d = (el) => { const r = el.getBoundingClientRect(); return Math.hypot(r.left - ir.left, r.top - ir.top); };
    // 不动 all 的原始顺序：调用方之后可能还要用 querySelectorAll 的结果
    best = [...all].sort((a, b) => d(a) - d(b))[0];
  }
  best.setAttribute('data-dsh-file', '1');
  return 'input[data-dsh-file="1"]';
})()`;

/**
 * 附件是否就绪。
 *
 * 三个条件缺一不可：
 *  - chip 文本出现 ≥ 文件数：Hark 把附件渲染成带文件名的 chip，没出现就是没挂上；
 *  - composer 里没有 progressbar / aria-busy：正在上传时点了发送，Hark 会把
 *    「还没传完」的那份发出去；
 *  - send-button 的 aria-label 含「发送」：空输入时它是「开始听写」，按下去
 *    只是开语音，消息根本不会发出去。
 *
 * composer 用「向上找第一个含文件名或含 file input 的祖先」定位，而不是固定层数：
 * Hark 的 DOM 层级会随版本变，写死 3 层迟早会截到 body，那样消息列表里的文件名
 * 也会被算进来，一次上传就永远「就绪」了。碰到消息气泡就停，防止退化成整页判断。
 */
const ATTACH_READY = (selector, names) => `(() => {
  const names = ${js(names)};
  const input = (window.__dshInput && window.__dshInput.isConnected)
    ? window.__dshInput
    : [...document.querySelectorAll(${js(selector)} || 'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]')]
        .find((el) => el.getBoundingClientRect().width > 0);
  if (!input) return { found: false };
  const hasName = (box) => {
    const t = box.innerText || '';
    return names.some((n) => t.includes(n));
  };
  // 为什么不能「碰到 file input 就停」：Hark 的 composer 分成
  //   <div A>                       ← 附件 chip 挂在这一层
  //     <div B>[textarea]</div>
  //     <div C>[input[type=file]]</div>
  //   </div>
  // B 才是「含 file input 的祖先」的最内层，但 chip 在 A 里，所以停在 B 上
  // 永远读不到文件名——每次上传都会白等到超时。改成先取「最外层仍能读到文件名」
  // 的祖先，读不到才退回到 file input 那一层。
  let named = null;
  let withInput = null;
  for (let p = input.parentElement, i = 0; p && i < 8; p = p.parentElement, i += 1) {
    if (p.querySelector('[data-testid=message-bubble]')) break;
    if (!withInput && p.querySelector('input[type=file]')) withInput = p;
    // 取「第一个」能读到文件名的祖先就是 composer：再往上爬会撞到消息列表里的
    // 历史附件名，那样上传成功一次之后永远都是「就绪」。
    if (!named && hasName(p)) named = p;
  }
  const box = named || withInput || input.parentElement || input;
  const text = box.innerText || '';
  const hits = names.filter((n) => text.includes(n)).length;
  const busy = box.getAttribute('aria-busy') === 'true'
    || !!box.querySelector('[role=progressbar], [aria-busy="true"]');
  const send = document.querySelector('button[data-testid=send-button]');
  const sendOk = send ? (!send.disabled && /发送/.test(send.getAttribute('aria-label') || '')) : true;
  return { found: true, hits, needed: names.length, busy, sendOk };
})()`;

/**
 * 取「含本次结束标记的那个用户气泡」的文本（找不到就用最后一个气泡）。
 *
 * 为什么用气泡而不是整页文本：文件名的文本 Hark 也会写进正文引用/附件清单，
 * 整页里几乎总能匹配上，那样校验就永远是绿的。
 */
const USER_BUBBLE_TEXT = (foot) => `(() => {
  const all = [...document.querySelectorAll('[data-testid=message-bubble]')];
  if (!all.length) return null;
  const hit = all.find((b) => (b.innerText || '').includes(${js(foot)}));
  return (hit || all[all.length - 1]).innerText || '';
})()`;

/** 在 ego 里把 Hark 页面切出来，复用同 origin 的现有标签，没有就开一个 */
const PICK_PAGE = (origin, url) => `
const want = ${js(url)};
const sameOrigin = ${js(origin)};
const task = await taskSpace('hark-bridge');
const tabs = await task.tabs();
let page = null;
for (const t of tabs) {
  if (t.url && sameOrigin && t.url.startsWith(sameOrigin)) {
    page = t.label ? await task.page(t.label) : await task.adopt(t.page);
    break;
  }
}
if (!page) { const pages = await task.pages(); page = pages.length ? pages[0] : await task.newPage(); }
const cur = await page.url().catch(() => '');
if (!sameOrigin || !cur.startsWith(sameOrigin) || cur.split('#')[0] !== want.split('#')[0]) {
  try {
    await page.goto(want, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    console.log(JSON.stringify({ ok: false, phase: 'goto', error: String((e && e.message) || e) }));
    process.exit(0);
  }
}
`;

/**
 * 找到回复里最新那张 md 附件卡片，打上 data-dsh-md 标记，返回卡片上的文件名。
 *
 * 为什么写成 Node 侧常量再由调用处 JSON.stringify 注入，而不是直接写在生成脚本的
 * 模板字符串里：这段表达式里全是正则（`\\.md$`、`\\s*打开\\s*`）。塞进模板字符串
 * 会被解析两次——源码的 `\\\\s` 先生成 `\\s`，再被内层反引号吃成 `s`，最终正则是
 * 「斜杠 s 星号 打开」那种形状，永远匹配不到「打开 reply.md 的预览」。症状是「卡片明明在页面上，
 * 脚本却报找不到」，而且不报错、静默超时，极难定位。走 JSON.stringify 只解析一次。
 *
 * 取最后一个而不是第一个：最新的回复在最下面，翻旧回复不是这里的目标。
 */
const MD_CARD_EXPR = (selector, end, action = 'find', exclude = []) => `(() => {
  const sel = ${js(selector)};
  const end = ${js(end || '')};
  // 本次自己上传的文件名：它们的卡片长得和 Hark 给的附件一模一样，
  // 位置也常常落在同一段区间里（审查意见 X1 的双保险）。
  const skip = ${js(Array.isArray(exclude) ? exclude.map(String) : [])};
  const all = sel ? [...document.querySelectorAll(sel)] : [...document.querySelectorAll('button[aria-label]')];
  const name = (b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/^\\s*打开\\s*/, '').replace(/\\s*的预览\\s*$/, '').trim();
  const hit = sel ? all : all.filter((b) => /\\.md$/i.test(name(b)));
  const bubbles = [...document.querySelectorAll('[data-testid=message-bubble]')];
  // 锚点：**本次回复里带结束标记的那个气泡**。找不到就不算数（审查意见 N2）。
  //
  // 为什么下界不能用「请求气泡」（审查意见 X1）：用户自己上传的 .md 卡片，
  // 一样可能渲染成请求气泡的兄弟节点——它满足「在请求之后」，于是被数进来，
  // FIND 取最后一个就把「我刚传上去的 README」当成了 Hark 的回复。
  // 结束标记是更强的锚：它由 Hark 写在回复正文里，用户上传的卡片一定在它之前。
  const endBub = end ? bubbles.find((b) => (b.innerText || '').indexOf(end) >= 0) : null;
  if (end && !endBub) return ${action === 'count' ? '{"count":0,"anchored":false}' : 'null'};
  // 上界：下一条用户请求。只认「第一行就是起始标签」的气泡（审查意见 拍板 3）：
  // 早先用 /\\[DSH#[a-z0-9]+\\]/ 全文匹配，可 Hark 解释协议时会在回复正文里引用
  // 请求编号，那时上界落到回复自己身上，卡片全被排除，mdCards 恒为 0 且不报错。
  // 真实请求的第一行固定是「[DSH#<编号>] <mode>」，这个形状回复不会照抄。
  const isReq = (b) => /^\\s*\\[DSH#[a-z0-9]+\\]\\s+(plan|review|chat)\\b/i.test(b.innerText || '');
  let nextReq = null;
  if (endBub) {
    nextReq = bubbles.find((b) => b !== endBub
      && (endBub.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
      && isReq(b)) || null;
  }
  const out = [];
  for (const b of hit) {
    if (skip.indexOf(name(b)) >= 0) continue;
    if (endBub) {
      // 按文档顺序筛，而不是按「卡片在哪个气泡里」（审查意见 N1）。
      // Hark 的文件卡片不一定挂在 message-bubble 内部——它可能是气泡的兄弟节点，
      // 或者在回复容器里与气泡并列。用 closest() 判断的话，这种布局下一张都找不到，
      // 整个下载通道静默失效。位置关系才是真实语义。
      //
      // 卡片在回复气泡**内部**也算（contains）：那是正常布局，不能像早先排除
      // 请求气泡里的 chip 那样排除掉。
      const after = endBub.contains(b)
        || (endBub.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (!after) continue;
      if (nextReq && !(b.compareDocumentPosition(nextReq) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    }
    out.push(b);
  }
  if (${action === 'count' ? 'true' : 'false'}) {
    return JSON.stringify({
      count: out.length,
      anchored: !!endBub,
      // 页面上总共有多少张：count 与 total 不等说明位置筛把一些排除了，
      // 排查"卡片明明在却不下载"时这是第一手信息。
      total: hit.length,
    });
  }
  if (!out.length) return null;
  // 取最后一个：最新的回复在最下面，翻旧回复不是这里的目标。
  const el = out[out.length - 1];
  el.setAttribute('data-dsh-md', '1');
  return name(el);
})()`;

const FIND_MD_CARD = (selector, end, exclude) => MD_CARD_EXPR(selector, end, 'find', exclude);
const COUNT_MD_CARDS = (selector, end, exclude) => MD_CARD_EXPR(selector, end, 'count', exclude);

/**
 * 附件弹窗里的下载链接。
 *
 * Hark 要两步：点卡片弹 `div[role=dialog]`，链接才出现。所以这里保留 document 兜底，
 * 万一某个版本把链接直接挂在卡片里，也不会因为在 dialog 里找不到就白白失败。
 */
const FIND_DOWNLOAD_LINK = `(() => {
  const dlg = document.querySelector('div[role=dialog]') || document;
  const a = dlg.querySelector('a[download]') || dlg.querySelector('a[href*="artifact"]');
  return a ? a.getAttribute('href') : null;
})()`;

/**
 * 下载脚本专用的选页：只复用同 origin 的现成标签，**绝不导航**。
 *
 * 为什么不复用 PICK_PAGE：它会 goto 一次去对齐 URL（`http://h/` 与 `http://h` 这种尾斜杠
 * 差异也会触发），而这发生在回复刚定稿之后——一次导航就把刚聊出来的那条回复和它下面的
 * md 卡片全冲掉，下载必然扑空，只能白等一个超时。下载阶段要的是「刚才那个页面」本身。
 */
const PICK_CURRENT_TAB = (origin) => `
const sameOrigin = ${js(origin)};
const task = await taskSpace('hark-bridge');
const tabs = await task.tabs();
let page = null;
for (const t of tabs) {
  if (t.url && sameOrigin && t.url.startsWith(sameOrigin)) {
    page = t.label ? await task.page(t.label) : await task.adopt(t.page);
    break;
  }
}
if (!page) {
  console.log(JSON.stringify({ ok: false, phase: 'attachment', error: '找不到刚才那个 Hark 标签页（可能已被关闭）' }));
  process.exit(0);
}
`;

/**
 * ask 用的完整脚本：选页 → 等输入框 → 打字回车 → 无限轮询页面文本。
 * 轮询不会自己停，父进程判定完成后直接 kill 子进程。
 *
 * 轮询只回传 footTag 之后的部分（审查意见 B3）：Hark 页面越长，整页 innerText
 * 越大（几十上百 KB），逐轮全量回传会让事件文件与父进程解析都变成 O(n²)；
 * 我们要的回复区间本来就在 footTag 之后。页面没变化时不回传，父进程有超时兜底。
 */
function buildAskScript(cfg) {
  const staged = Array.isArray(cfg.staged) ? cfg.staged.filter((p) => typeof p === 'string' && p) : [];
  const names = Array.isArray(cfg.uploadNames) ? cfg.uploadNames.map(String) : [];
  return `
const C = ${JSON.stringify({
    inputSelector: cfg.inputSelector || '',
    sendSelector: cfg.sendSelector || '',
    loginWaitSec: cfg.loginWaitSec,
    pollMs: cfg.pollMs,
    attachTimeoutSec: Number(cfg.attachTimeoutSec) || 60,
    message: cfg.message,
    foot: cfg.foot,
    // 结束标记是数卡片的锚点（审查意见 X1）：用户自己上传的卡片一定在它之前。
    end: cfg.end || '',
    staged,
    uploadNames: names,
    resetComposer: Boolean(cfg.resetComposer),
    focus: FOCUS_INPUT(cfg.inputSelector),
    inputLen: INPUT_LEN,
    clickSend: CLICK_SEND(cfg.sendSelector),
    pageText: PAGE_TEXT,
    markFileInput: MARK_FILE_INPUT(cfg.fileInputSelector || ''),
    attachReady: ATTACH_READY(cfg.inputSelector || '', names),
    bubbleText: USER_BUBBLE_TEXT(cfg.foot),
    // 自己上传的文件名要排掉：它们和 Hark 给的附件在页面上长得一样，
    // 位置也落在同一段区间里，只靠位置分不开。
    countMdCards: COUNT_MD_CARDS(cfg.attachmentSelector || '', cfg.end || '', names),
  })};
const emit = (o) => console.log(JSON.stringify({ ok: true, ...o }));
const fail = (phase, error) => { console.log(JSON.stringify({ ok: false, phase, error })); process.exit(0); };

${PICK_PAGE(cfg.origin, cfg.harkUrl)}

// 输入框出现 = 页面真的加载完了，也顺带确认登录状态还在
const waitFocus = async () => {
  const deadline = Date.now() + C.loginWaitSec * 1000;
  while (Date.now() < deadline) {
    if (await page.evaluate(C.focus).catch(() => false)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
};

if (!(await waitFocus())) fail('focus');
emit({ phase: 'open' });

if (C.staged.length || C.resetComposer) {
  // 为什么必须 reload 而不是就地清空：上一次失败的 ask 可能在 composer 里留下
  // 附件 chip，Hark 不会因为「这次没选文件」就把它们丢掉——不刷新，残留会跟着
  // 这条消息一起发出去，用户看到的就是「我只问了一句，它却收到了上次的文件」。
  //
  // resetComposer 专门给降级内联用（审查意见 B2）：那条路径 staged 是空的，
  // 但它恰恰发生在「刚刚上传失败」之后，是 composer 里最可能留着 chip 的时刻。
  // 早先 reload 只写在 staged 分支里，于是降级重发正好漏掉了这一次清理。
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  if (!(await waitFocus())) fail('focus');
}

if (C.staged.length) {
  // 附件 input 是隐藏的（offsetWidth/Height=0），挑不了「可见的那个」，只能按
  // 离输入框的远近选，否则会撞上页面上别的 file input（头像、导入配置之类）。
  let fileSel = null;
  const markDeadline = Date.now() + C.attachTimeoutSec * 1000;
  while (!fileSel && Date.now() < markDeadline) {
    fileSel = await page.evaluate(C.markFileInput).catch(() => null);
    if (!fileSel) await page.waitForTimeout(300);
  }
  if (!fileSel) fail('attach', '页面上找不到可用的文件输入框（input[type=file]）');

  // 直接 setInputFiles 绕开「添加附件」按钮弹出的系统文件选择框：
  // 那是原生 modal，ego 点不动、也不会自己消失，会把后续所有操作卡死。
  try {
    await page.setInputFiles(fileSel, C.staged);
  } catch (e) {
    fail('attach', '挂载附件失败：' + String((e && e.message) || e));
  }

  const attachDeadline = Date.now() + C.attachTimeoutSec * 1000;
  let streak = 0;
  let ready = false;
  while (Date.now() < attachDeadline) {
    const st = await page.evaluate(C.attachReady).catch(() => null);
    const okNow = !!st && st.found && st.hits >= st.needed && !st.busy && st.sendOk;
    // 为什么要连续两次：上传不是一次原子跳变（chip 先出现、缩略图后补、
    // 发送按钮最后才启用），单次采样很容易撞在中间态上；按中间态发送，
    // Hark 会把「还没传完」的那一份发出去，正文里就少一个附件。
    streak = okNow ? streak + 1 : 0;
    if (streak >= 2) { ready = true; break; }
    await page.waitForTimeout(Math.min(500, Math.max(100, C.pollMs)));
  }
  if (!ready) fail('attach', C.attachTimeoutSec + ' 秒内附件没有就绪（chip 未出现或发送按钮未启用）');
  emit({ phase: 'attach', ready: true });
}

await page.keyboard.insertText(C.message);
await page.waitForTimeout(300);
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
const rest = await page.evaluate(C.inputLen).catch(() => -1);
if (rest > 0) {
  const clicked = await page.evaluate(C.clickSend).catch(() => false);
  if (!clicked) { console.log(JSON.stringify({ ok: false, phase: 'send' })); process.exit(0); }
  await page.waitForTimeout(1500);
}
emit({ phase: 'sent' });

let lastTail = null;
let lastSent = null;
let fails = 0;
let verified = false;
let verifyTicks = 0;
// 页面上「本次请求之后、Hark 回复里」到底有没有 md 卡片。
//
// 这是判断要不要下载的唯一依据（审查意见 B3）。早先靠页面 innerText 猜
// 「长不长、像不像文档」，可 Hark 气泡里显示的是**渲染后**的 Markdown：
// 标题没有 #、列表符号是 ::marker 不进 innerText、代码块没有三反引号、
// 表格变成制表符——五个结构信号几乎恒为 0，于是生产上从不下载。
// 现在 Hark 被规则明确要求「长内容生成 .md 文件」，页面有没有卡片就是权威答案。
let lastMdCards = 0;
// anchored = 有没有定位到本次请求那条气泡。没定位到就绝不能下载（审查意见 N2）：
// 那时"页面上的卡片"里混着上一轮遗留的旧审查，取回来会把过期内容当成新回复。
let lastAnchored = false;
let lastMdTotal = 0;
while (true) {
  // 单轮读页失败不该直接判死：网络抖动、渲染中、Hark 重排都会让 evaluate 抛错。
  // 连续失败才上抛（审查意见 S1）——一直把错误吞成空字符串，父进程会误报
  // "页面读不到内容了"，用户按提示 /hark-login 重开也没用。
  let text = null;
  try {
    text = await page.evaluate(C.pageText);
    fails = 0;
  } catch (e) {
    fails += 1;
    if (fails >= 5) {
      console.log(JSON.stringify({ ok: false, phase: 'poll', error: String((e && e.message) || e) }));
      process.exit(0);
    }
    await page.waitForTimeout(C.pollMs);
    continue;
  }
  const raw = String(text || '');
  const at = raw.indexOf(C.foot);
  // 只在页面上已经出现本请求之后才数卡片：没出现时锚点必然不存在，
  // 数一次等于白跑一次 evaluate（每一秒一次，长对话里累积不少）。
  let mdCards = lastMdCards;
  let anchored = lastAnchored;
  let mdTotal = lastMdTotal;
  if (at >= 0) {
    const cards = await page.evaluate(C.countMdCards).catch(() => null);
    // 解析失败（脚本抛错、返回形状变了）只保留上一次的值，不影响回复判定：
    // 数卡片只是"要不要下载"的旁证，下载环节自己还会再找一次。
    let parsed = null;
    try { parsed = typeof cards === 'string' ? JSON.parse(cards) : cards; } catch { parsed = null; }
    if (parsed && Number.isFinite(parsed.count)) {
      mdCards = parsed.count;
      anchored = parsed.anchored === true;
      if (Number.isFinite(parsed.total)) mdTotal = parsed.total;
      lastMdCards = mdCards; lastAnchored = anchored; lastMdTotal = mdTotal;
    }
  }
  // 心跳：父进程要靠持续的事件流判断「还没回」「页面丢了」「已经稳定」，
  // 只在 tail 变化时才 emit 会让它在 Hark 沉默时完全静默，一直等到超时。
  // 未变化的轮次不带 text（只是一个小行），避免把长文本反复写进事件文件。
  if (at < 0) {
    // sent:false = 页面上还看不到我们的请求
    if (lastSent !== false) { lastSent = false; lastTail = null; emit({ phase: 'poll', sent: false, pageLen: raw.length, mdCards, anchored }); }
    else emit({ phase: 'poll', sent: false, pageLen: raw.length, same: true, mdCards, anchored });
  } else {
    const tail = raw.slice(at + C.foot.length);
    if (tail !== lastTail || lastSent !== true) {
      lastSent = true; lastTail = tail;
      emit({ phase: 'poll', sent: true, text: tail, pageLen: raw.length, mdCards, anchored, mdTotal });
    } else {
      emit({ phase: 'poll', sent: true, pageLen: raw.length, same: true, mdCards, anchored, mdTotal });
    }
    // 发送后校验：气泡出现 ≠ 附件发出去了。Hark 有时会把「附件还在传」的那条
    // 直接发出去，页面上看得到消息、却没有文件；不校验的话用户以为传上去了，
    // Hark 其实只收到一句「见我上传的文件」。
    // 只查一次：轮询是每秒一次的长循环，反复 emit 同一份缺失清单只会刷屏。
    if (C.uploadNames.length && !verified && ++verifyTicks >= 2) {
      verified = true;
      const bubble = await page.evaluate(C.bubbleText).catch(() => null);
      if (typeof bubble === 'string') {
        const missing = C.uploadNames.filter((n) => !bubble.includes(n));
        if (missing.length) emit({ phase: 'attach-missing', names: missing });
      }
    }
  }
  await page.waitForTimeout(C.pollMs);
}
`;
}

/**
 * 下载 Hark 回复里附带的 md 附件。
 *
 * 为什么单独跑一个脚本而不是塞进 ask 的轮询循环：轮询循环的职责是「读页面文本、
 * 判断回复是否结束」，它每秒读一次整页 innerText 且从不退出；把滚动、点卡片、
 * 打开 dialog、fetch 下载这些一次性动作混进去，会让轮询的分支越来越难判断，
 * 而且 dialog 一打开页面文本就变了，extractReply 会误判成「回复被改掉」。
 * 主 ask 已经结束，这里只要一个干净的一次性脚本。
 */
function buildFetchAttachmentScript(cfg) {
  const exclude = Array.isArray(cfg.uploadNames) ? cfg.uploadNames.map(String) : [];
  return `
const C = ${JSON.stringify({
    attachmentSelector: cfg.attachmentSelector || '',
    origin: cfg.origin,
    saveAs: cfg.saveAs,
    name: cfg.name || '',
    // 卡片可能只是被重渲染短暂摘掉（审查意见 拍板 4）：轮询 5 次、每次间隔 1 秒，
    // 比单次求值稳得多。再长就属于「真的没了」，白等只会拖慢整次往返。
    tries: 5,
    gapMs: 1000,
    waitMs: 15_000,
  })};
const emit = (o) => console.log(JSON.stringify({ ok: true, ...o }));

${PICK_CURRENT_TAB(cfg.origin)}

// 懒加载：附件的卡片不滚到底就不会渲染进 DOM，直接 querySelectorAll 会一直是空的。
await page.evaluate(\`(() => {
  const scrollers = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 20);
  for (const e of scrollers) e.scrollTop = e.scrollHeight;
  window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
  return true;
})()\`).catch(() => {});

// 卡片是懒渲染的，滚完还要等一拍；轮询而不是固定 sleep，慢机器也能过。
// 表达式本体在 Node 侧（FIND_MD_CARD），这里只注入求值结果，避免正则被二次转义。
const findExpr = ${JSON.stringify(FIND_MD_CARD(cfg.attachmentSelector || '', cfg.end || '', exclude))};

let card = null;
for (let i = 0; i < C.tries && !card; i += 1) {
  card = await page.evaluate(findExpr).catch(() => null);
  if (!card && i + 1 < C.tries) await page.waitForTimeout(C.gapMs);
}
if (!card) {
  // 文案要说清「曾经有过」还是「从头就没有」：前者多半是重渲染，后者是锚点/布局问题，
  // 排查方向完全不同。
  const had = Number(${JSON.stringify(Number(cfg.mdCards) || 0)});
  const why = had > 0
    ? \`页面上曾出现 \${had} 个属于本次回复的 .md 附件，下载时未找到（可能被重渲染或滚动移出）\`
    : '页面上找不到属于本次回复的 .md 附件卡片';
  console.log(JSON.stringify({ ok: false, phase: 'attachment', error: why }));
  process.exit(0);
}

// 点击本身可能失败：卡片刚被滚动插进 DOM、动画还没结束、或正好被别的浮层盖住。
// 早先这里是 page.click(...).catch 静默吞掉失败，然后干等 15 秒报「没有下载链接」——
// 错误信息指向链接，真正的原因却是「根本没点开」，排查时绕远路。所以改成：
// 点不开就换 evaluate 直接派发 click，之后在轮询里再补点几次（每 8 轮一次）。
const clickCard = async () => {
  try { await page.click('[data-dsh-md="1"]'); return true; } catch {}
  return await page.evaluate(\`(() => {
    const el = document.querySelector('[data-dsh-md="1"]');
    if (!el) return false;
    el.click();
    return true;
  })()\`).then((v) => v === true).catch(() => false);
};
let opened = await clickCard();
let href = null;
const dlDeadline = Date.now() + C.waitMs;
const linkExpr = ${JSON.stringify(FIND_DOWNLOAD_LINK)};
let retries = 0;
while (!href && Date.now() < dlDeadline) {
  href = await page.evaluate(linkExpr).catch(() => null);
  if (href) break;
  if (!opened || ++retries % 8 === 0) opened = await clickCard();
  await page.waitForTimeout(300);
}
if (!href) { console.log(JSON.stringify({ ok: false, phase: 'attachment', error: '附件弹窗里没有下载链接' })); process.exit(0); }

// 为什么用 page.fetch 而不是 waitForEvent('download')：实测 download 事件在 ego
// 这里拿不到（下载走的是页面自己的 fetch + cookie），而 page.fetch 带上页面 cookie
// 能直接拿到完整字节，还能指定 saveAs，不依赖用户的下载目录设置。
let bytes = null;
try {
  // 返回值的字段名各版本不一样（size/bytes/body.length 都见过），所以逐个试；
  // 拿不到也不要紧，父进程会用 statSync 校正成磁盘上的真实大小。
  const got = await page.fetch(href.startsWith('http') ? href : C.origin + href, { saveAs: C.saveAs, timeout: 30000 });
  if (got && typeof got === 'object') {
    bytes = Number.isFinite(got.size) ? got.size
      : Number.isFinite(got.bytes) ? got.bytes
        : (got.body && Number.isFinite(got.body.length) ? got.body.length : null);
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, phase: 'attachment', error: '下载失败：' + String((e && e.message) || e) }));
  process.exit(0);
}
emit({ phase: 'attachment', saved: C.saveAs, name: C.name || card, bytes });
`;
}

/** 页面文本连续这么久是空的，就当页面丢了（导航走、被关、崩了），别干等到超时 */
const EMPTY_PAGE_MS = 60_000;

export class HarkBridge {
  /**
   * @param {() => object} getConfig
   * @param {{ log?: Function, streamScript?: Function, runScript?: Function, lockDir?: string }} [deps]
   *   streamScript / runScript 允许测试注入假的 ego 通道，生产代码不传。
   */
  constructor(getConfig, deps = {}) {
    this.getConfig = getConfig;
    this.logger = deps.log || console;
    this.streamScript = deps.streamScript || streamEgoScript;
    this.runScript = deps.runScript || runEgoScript;
    this.lockDir = deps.lockDir || null;
    this.queue = Promise.resolve();
  }

  /** 把 Hark 页面在用户的 ego 里打开并切到前台，供首次登录 */
  async openForLogin() {
    const c = this.#config({ requireUrl: true });
    const script = `
${PICK_PAGE(c.origin, c.harkUrl)}
await page.cdp('Page.bringToFront', {}).catch(() => {});
console.log(JSON.stringify({ ok: true, url: await page.url().catch(() => '') }));
`;
    const r = await this.runScript(script, { exePath: c.browserPath, timeoutMs: 90_000 });
    if (!r || typeof r !== 'object') {
      throw new Error('没能和 ego 建立连接：请确认 ego lite 正在运行（打开一次 ego 窗口即可），然后重试');
    }
    return `已在 ego 里打开 ${r.url || c.harkUrl}。如未登录，请在该标签页里登录一次；之后会自动保持登录。`;
  }

  /**
   * @param {{ requireUrl?: boolean }} [opts] requireUrl=false 时，没配 harkUrl 直接返回 null
   */
  #config({ requireUrl = true } = {}) {
    const c = this.getConfig();
    if (!c.harkUrl) {
      if (!requireUrl) return null;
      throw new Error('还没有设置 Hark 地址：在 DSH 里执行 /hark-url https://…（Hark 对话页面的地址）');
    }
    let origin = '';
    try { origin = new URL(c.harkUrl).origin; } catch { throw new Error(`harkUrl 不是合法网址：${c.harkUrl}`); }
    return { ...c, origin };
  }

  /**
   * 串行排队，避免两个请求同时往一个输入框里打字。
   *
   * 排队期间被取消必须立刻返回（审查意见 S2）：早先要等前一个请求跑完才抛
   * AbortError，用户按了停止后界面还卡着，最长要等满一个 timeoutMin。
   */
  ask(mode, body, opts = {}) {
    const previous = this.queue;
    const signal = opts.signal;
    let cancelled = false;
    let onAbort = null;

    const run = new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError(signal)); return; }
      if (signal) {
        onAbort = () => { cancelled = true; reject(abortError(signal)); };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      previous.then(async () => {
        // 排队期间被取消：绝不能真的往 Hark 页面里打字。
        if (cancelled || signal?.aborted) throw abortError(signal);
        // 握手放在 #ask 的跨进程锁里做（审查意见 S2），不在这里——
        // 握手的发消息动作和正式请求一样会往同一个输入框打字，
        // 放在锁外，两个 DSH 会话就会同时往 Hark 里塞消息，
        // 而 RULES_VERSION 一升，所有会话下次都会重新握手，正好制造这个撞车。
        return this.#ask(mode, body, opts);
      }).then(resolve, reject);
    }).finally(() => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    });

    // 队列只关心「这一轮结束」，不看结果；失败已经在 run 上抛给调用方了。
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * 首次在该 Hark 页面协作时，先把协议规则完整发一遍。
   *
   * 为什么值得多花一次往返：Hark 不会自己知道结束标记要写成 [[DSH-END#id]]，
   * 不教它就只能靠猜，而猜错的代价是整整等满 timeoutMin 然后拿到一个超时错误。
   * buildMessage 每条也带了简版提示，所以即使握手没成功、或者对话上下文被压缩，
   * 也不会退化成纯靠猜。
   *
   * 握手失败不阻断正式请求——Hark 可能已经在这个对话里学会了规则，
   * 真正有没有说上话由紧接着的 #ask 判定。但「找不到输入框」要立刻上抛
   * （审查意见 S6）：那说明没登录或地址不对，握手和正式请求都会白等
   * loginWaitSec，加起来 4 分钟才给出一个本该 1 分钟就报的错误。
   */
  async #handshake({ signal } = {}) {
    let c;
    try { c = this.#config({ requireUrl: false }); } catch { return; }
    if (!c) return;
    const done = readOverride().handshakes;
    const seen = done && typeof done === 'object' ? done[c.harkUrl] : undefined;
    if (seen === RULES_VERSION) return;

    const id = newRequestId();
    const script = buildAskScript({ ...c, foot: footTag(id), end: endTag(id), message: buildMessage(id, 'chat', buildRulesBody()) });
    // 握手只是确认一句「收到」，给它比正式请求更短的预算，失败就往下走。
    const budget = Math.min(c.timeoutMin, 3);
    const startedAt = Date.now();
    try {
      for await (const ev of this.streamScript(script, { exePath: c.browserPath, signal })) {
        if (ev.phase !== 'poll') continue;
        // 同 #runAsk：脚本只回传 footTag 之后的尾部，这里补回锚点。
        const tail = ev.sent === false ? '' : String(ev.text ?? '');
        if (tail && extractReply(footTag(id) + tail, id).status === 'done') {
          this.#rememberHandshake(c.harkUrl);
          return;
        }
        if (Date.now() - startedAt > budget * 60_000) break;
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (e.name === 'EgoStageError' && e.stage === 'focus') throw loginError();
      // 网络、ego、超时都不阻断：正式请求会再试一次，而且报错更准确。
      this.logger?.warn?.(`[dsh-hark-bridge] 规则握手未完成：${e?.message || e}`);
    }
  }

  #rememberHandshake(url) {
    try {
      const current = readOverride();
      const map = current.handshakes && typeof current.handshakes === 'object' ? current.handshakes : {};
      writeOverride({ handshakes: { ...map, [url]: RULES_VERSION } });
    } catch { /* 记不下来就下次再发一遍，不影响功能 */ }
  }

  async #ask(mode, body, opts = {}) {
    // 下载目标两种给法：完整路径（attachmentSavePath，测试与自定义用），
    // 或「目录 + 带 <id> 占位的文件名」——后者是插件默认，因为落盘名要和回复正文
    // 那个 md 配套，而 id 只有这里才生成，调用方拿不到。
    const { signal, attachmentSaveDir, attachmentSaveName } = opts;
    const c = this.#config();
    const warnings = [];
    // 先定 id 再备附件：默认暂存目录名要用它，两次 concurrent ask 才不会落进同一个目录。
    const id = newRequestId();
    // id 定下来后才知道下载文件名，所以路径在这里算。函数是因为「降级重发」会换 id：
    // 附件落在旧 id 名下，就跟返回的 id 对不上了。
    const savePathOf = (rid) => opts.attachmentSavePath
      || (attachmentSaveDir ? join(attachmentSaveDir, String(attachmentSaveName || '<id>.hark.md').replace('<id>', rid)) : '');
    const paths = attachmentPathsOf(opts);
    let stageDir = null;
    let list = [];
    // 实际要发出去的正文。默认就是 body；超长且开了 autoAttachOverflow 时会被替换成一句指路话。
    let outgoing = String(body);

    // 正文超长的处理（审查意见 S4：这个配置项一直有、没实现）。
    //
    // 为什么不只是「截断」：超长正文几乎都是 diff 或整份文件，截断之后 Hark 看到的是
    // 半份代码，它给出的方案会基于缺失的上下文——比直接失败更糟。
    // 为什么整段而不是只把超出部分转附件：切开的两半在 Hark 那边是两处上下文，
    // 它读代码时要来回翻，更容易漏。
    let overflow = null;
    if (outgoing.length > c.maxChars) {
      if (!c.autoAttachOverflow) {
        throw new Error(`内容 ${outgoing.length} 字符，超过上限 ${c.maxChars}，请拆分或只发 diff`);
      }
      const len = outgoing.length;
      // 目录一旦建出来，就得记住它：中途写失败时 stageDir 还没赋值，
      // 外层的 finally 拿不到路径，会把这个刚建的目录留在工作区里（审查意见 建议 2）。
      let madeDir = null;
      try {
        const dir = stageDirOf(opts, id);
        madeDir = dir;
        mkdirSync(dir, { recursive: true });
        const name = `正文-${id}.md`;
        const file = join(dir, name);
        writeFileSync(file, outgoing, 'utf8');
        overflow = {
          rel: name,
          abs: file,
          staged: file,
          uploadName: name,
          bytes: statSync(file).size,
          sha256: sha256Of(file),
          // 标一下来源：上传失败降级时要说「正文转成的附件没传上去」，
          // 而不是笼统的「附件上传超时」。
          overflow: true,
        };
        // 这里就把 stageDir 记下来，别指望后面 got.items 分支去赋值——
        // 正文转附件时可能一个 attachmentPaths 都没有，finally 就清不掉这个目录了。
        stageDir = dir;
      } catch (e) {
        // 只清自己刚建的那个目录：cleanupStaging 会校验路径形状，不会动别处。
        if (madeDir) { try { cleanupStaging(madeDir); } catch { /* 清不掉就留给下次启动清 */ } }
        throw new Error(`内容 ${len} 字符，超过上限 ${c.maxChars}，自动转成附件也失败了：${e?.message || e}`);
      }
      outgoing = `本次正文较长（${len} 字符），完整内容已作为附件「${overflow.uploadName}」发送，请以附件为准。`;
      warnings.push(`正文 ${len} 字符超过上限 ${c.maxChars}，已改写成附件 ${overflow.uploadName}`);
    }

    try {
      // 两条入口，优先级分明：attachments 是调用方已经暂存好的成品，直接拿来用；
      // attachmentPaths 是"给我原始路径、我来校验并暂存"。之所以不合并成一条，
      // 是因为暂存时机属于调用方的决定（它可能想先把同一批文件复用到别处），
      // 而 bridge 只该关心"这次要挂哪些 staged 文件"。同时传两个会让同一批
      // 文件被暂存两次、页面收到两份同名 chip，所以 attachments 非空就不看 paths。
      list = normalizeAttachments(opts.attachments);
      if (!list.length && paths.length) {
        // 路径校验失败要原样上抛：AttachError 的 message 是写给模型看的
        // （越界/敏感文件/超限各自说得具体），包一层只会把它压成「附件错误」。
        const got = collectAttachments(paths, {
          workspaceRoot: opts.workspaceRoot,
          maxFiles: c.maxFiles,
          maxFileBytes: c.maxFileBytes,
          maxTotalBytes: c.maxTotalBytes,
        });
        // 被跳过的文件不是错误（十个里错一个），但用户必须知道少发了什么。
        for (const s of got.skipped || []) warnings.push(`附件已跳过：${s.reason}`);
        if (got.items.length) {
          stageDir = stageDirOf(opts, id);
          list = normalizeAttachments(stageAttachments(got.items, stageDir));
        }
      }
      // 正文转来的附件放在最前面：清单里它排第一，Hark 打开第一个就是全文。
      if (overflow) list = [overflow, ...list];

      // 同一份 body 会因为「降级」被发两次，所以脚本按 (id, 正文, 是否带附件) 现拼，
      // 而不是提前拼好一个：内联降级要换掉正文，还得换 id（页面上会留下两条请求，
      // 沿用旧 id 会让 extractReply 看到两份同 id 的区间）。
      const script = (rid, bodyText, withAttach) => buildAskScript({
        ...c,
        foot: footTag(rid),
        end: endTag(rid),
        message: buildMessage(rid, mode, bodyText),
        staged: withAttach ? list.map((a) => a.staged) : [],
        uploadNames: withAttach ? list.map((a) => a.uploadName) : [],
      });
      const names = list.map((a) => a.uploadName);
      // 清单跟在正文后面：Hark 那边只看到一串扁平文件名（lib__bridge.js），
      // 加上原始相对路径和大小，它才知道哪个文件是哪个、该先读哪个。
      const text = outgoing + manifestSection(list);
      if (signal?.aborted) throw abortError(signal);

      const release = await acquireLock(this.lockDir, signal);
      try {
        // 握手也在锁内：#handshake 会往同一个输入框打字，放在锁外就等于允许
        // 两个进程同时往 Hark 里发消息（审查意见 S2）。放在这里还有一个好处——
        // 握手失败、或刚好被别的会话握过了，都不会白占一次锁排队。
        await this.#handshake({ signal });
        if (!list.length) {
          const res = await this.#runAsk(c, id, script(id, text, false), signal, {
            warnings, attachmentSavePath: savePathOf(id), mode,
          });
          return finishAsk(id, res, 'none', [], warnings);
        }
        try {
          const res = await this.#runAsk(c, id, script(id, text, true), signal, {
            warnings, attachmentSavePath: savePathOf(id), uploadNames: names, mode,
          });
          // attachReady=false 说明脚本连 attach 阶段都没走到就发出去了（理论上不会），
          // 这时不能对调用方声称"已上传"——附件可能根本没挂上。
          return finishAsk(id, res, 'upload', res.attachReady ? names : [], warnings);
        } catch (e) {
          // 只有「附件没就绪」可以降级；其它阶段（focus/send/poll）的失败降级也救不回来，
          // 内联一遍只会再多等一个超时。
          if (e?.name !== 'EgoStageError' || e.stage !== 'attach') throw e;
          return await this.#degradeToInline(c, mode, body, list, e, {
            signal, attachmentSavePath: savePathOf, warnings,
          });
        }
      } finally {
        release();
      }
    } finally {
      // 暂存的是工作区文件的副本，请求结束（成功/降级/抛错）就没有用了。
      // 不删会在 .hark/attach 下越积越多，下次 ask 还得从一堆积压里认自己那份。
      cleanupStaging(stageDir);
    }
  }

  /**
   * 附件挂不上时的降级：把文件正文贴进消息里重发一次。
   *
   * 为什么值得多绕一圈：Hark 的 composer 偶尔会卡在上传、或者 file input 干脆没渲染出来。
   * 对用户来说「文件没传上去」和「这次对话直接失败」是两种完全不同的结果——后者要重来一遍，
   * 前者至少还能让 Hark 看到代码。代价是 token，所以只在总量放得下时降级。
   */
  async #degradeToInline(c, mode, body, list, cause, { signal, attachmentSavePath: savePathOf, warnings }) {
    const total = list.reduce((s, a) => s + (a.bytes || 0), 0);
    // 正文已经被转成附件了（autoAttachOverflow）：这时说「内容过大无法内联」
    // 会让模型和用户都以为要拆小重发，其实原文就在本地、只是没传上去。
    // 报清楚真实情况，下一步该做什么才明确（审查意见 建议 3）。
    const overflowed = list.some((a) => a && a.overflow === true);
    const why = overflowed
      ? '正文过长已转成附件，但附件上传失败'
      : '附件上传超时';
    if (total > c.maxChars) {
      const e = new Error(
        `${why}，且内容过大无法内联：共 ${total} 字节，超过上限 ${c.maxChars}（${cause?.message || cause}）`,
      );
      e.name = 'HarkAttachError';
      throw e;
    }
    const extra = inlineAttachments(list, warnings);
    const text = body + extra;
    if (text.length > c.maxChars) {
      const e = new Error(
        `${why}，且内容过大无法内联：内联后正文 ${text.length} 字符，超过上限 ${c.maxChars}`,
      );
      e.name = 'HarkAttachError';
      throw e;
    }
    warnings.push(`${overflowed ? '正文转成的附件' : '附件'}上传未就绪，已降级为正文内联（共 ${list.length} 个文件）`);
    const id = newRequestId();
    const res = await this.#runAsk(c, id, buildAskScript({
      ...c,
      foot: footTag(id),
      end: endTag(id),
      message: buildMessage(id, mode, text),
      staged: [],
      uploadNames: [],
      // 刚刚上传失败，composer 里最可能残留上一次的附件 chip。
      // 不刷新就发，会把「上一批没发出去的文件」一起带上（审查意见 B2）。
      resetComposer: true,
    }), signal, { warnings, attachmentSavePath: savePathOf(id), mode });
    return finishAsk(id, res, 'inline', [], warnings);
  }

  async #runAsk(c, id, script, signal, ctx = {}) {
    const deadline = Date.now() + c.timeoutMin * 60_000;
    const sendDeadline = Date.now() + 30_000;
    let last = { status: 'not-sent', reply: '' };
    let sentSeen = false;
    let doneAt = 0;
    let emptySince = 0;
    // 附件相关的旁证：脚本只回事件，这里把它们收集起来折算成返回值上的字段。
    const warnings = Array.isArray(ctx.warnings) ? ctx.warnings : [];
    let attachReady = false;
    let missingNotified = false;
    // 页面上有没有 md 卡片：脚本每轮数一下带回来，取到过的最大值即为结论。
    // 不用「最后一轮」的值——settle 期间页面可能重渲染把卡片短暂摘掉。
    let mdCards = 0;
    // anchored：有没有定位到本次请求那条气泡。没有就绝不下载（审查意见 N2）。
    let anchored = false;
    // 页面上 md 卡片总数（含位置筛排除掉的）：count 与 total 不等时用来解释
    // 「为什么明明有卡片却不下载」。
    let mdTotal = 0;
    // 卡片宽限期的截止时刻（审查意见 N3），见下面 settle 分支。
    let graceUntil = 0;
    // plan/review 才会要文件：Hark 被规则要求「长内容生成 .md」，方案和审查属于这一类；
    // chat 是闲聊，等文件只会白等，保持原来的响应速度。
    const wantsFile = ctx.mode === 'plan' || ctx.mode === 'review';
    let finished = null;
    // 文字已定稿、但可能还在等卡片（宽限期）。和 finished 分开，是因为
    // 宽限期可能撞上 timeoutMin 或 poll 流提前结束——那两种情况回复其实已经完整，
    // 不能因此报「没给出结束标记」。
    let settled = null;

    try {
      for await (const ev of this.streamScript(script, {
        exePath: c.browserPath,
        signal,
        timeoutMs: c.timeoutMin * 60_000 + 30_000,
      })) {
        if (ev.phase === 'attach') {
          if (ev.ok === false) continue; // 失败型 attach 由 ego 抛 EgoStageError，这里不重复处理
          attachReady = true;
          continue;
        }
        // 发送后校验的缺失清单：不在脚本里直接判死，交给调用方决定要不要提示用户，
        // Hark 侧有时只是气泡文本还没渲染完，文件其实已经在对话里了。
        if (ev.phase === 'attach-missing') {
          const names = Array.isArray(ev.names) ? ev.names.map(String) : [];
          if (names.length && !missingNotified) {
            missingNotified = true;
            warnings.push(`发送后校验未在气泡里找到附件：${names.join('、')}`);
          }
          continue;
        }
        if (ev.phase === 'attachment' && ev.ok !== false) {
          // 下载脚本自己的事件，由 #fetchAttachment 收集，这里不参与回复判定。
          continue;
        }
        if (ev.phase === 'sent') continue;
        if (ev.phase === 'poll') {
          if (Number.isFinite(ev.mdCards) && ev.mdCards > mdCards) mdCards = Number(ev.mdCards);
          if (ev.anchored === true) anchored = true;
          if (Number.isFinite(ev.mdTotal) && ev.mdTotal > mdTotal) mdTotal = Number(ev.mdTotal);
          // 脚本只回传 footTag 之后的尾部（审查意见 B3：整页 innerText 会随对话
          // 增长到几十上百 KB，逐轮全量回传是 O(n²)）。这里补回 footTag，
          // 让 extractReply 看到的输入与「整页文本」语义一致。
          //
          // same:true 表示这一轮尾部没变（脚本每 pollMs 都发心跳，只在变化时带 text）。
          // 这时不能把 last 重置成 not-sent，否则刚看到的结束标记会被下一轮心跳抹掉，
          // settle 永远等不满。
          const changed = ev.same !== true;
          if (changed) {
            const tail = ev.sent === false ? '' : String(ev.text ?? '');
            const text = ev.sent === false ? '' : footTag(id) + tail;
            last = extractReply(text, id);
          }
          // pageLen 是脚本读到的整页长度：区分「页面没了」和「Hark 还没回」
          // ——后者尾部本来就是空的，不能当成页面丢失。
          const pageLen = Number.isFinite(ev.pageLen) ? Number(ev.pageLen) : -1;
          if (last.status !== 'not-sent') sentSeen = true;
          if (!sentSeen && Date.now() > sendDeadline) {
            throw new Error(`30 秒内页面上没出现已发送的消息（${footTag(id)}），发送可能失败`);
          }

          // 页面丢了（导航走 / 标签被关 / 渲染崩了）：整页文本会变成空。
          // 早先的实现会一路轮询到 timeoutMin 才报超时，把「页面没了」
          // 和「Hark 没回」混成同一个错误（审查意见 S4）。
          if (sentSeen && pageLen === 0) {
            if (!emptySince) emptySince = Date.now();
            else if (Date.now() - emptySince > EMPTY_PAGE_MS) {
              throw new Error('Hark 页面忽然读不到内容了（可能被导航或关闭）：请用 /hark-login 重新打开，再重试');
            }
          } else {
            emptySince = 0;
          }

          // settle：看到结束标记后再等一会儿，确认它没被后续内容改掉
          // （流式渲染时标记可能先出现、随后正文还在补）。早先是 sleep 完直接返回，
          // 期间的变化看不到（审查意见 S3）。
          if (last.status === 'done') {
            if (!doneAt) doneAt = Date.now();
            if (Date.now() - doneAt >= c.settleMs) {
              // 文字定稿这件事本身要先记下来，和「有没有卡片」分开（见循环后的兜底）。
              // uploadNames 带上：下载时要排掉「我自己刚上传的那些 .md」，
              // 否则会把刚发出去的 README 当成 Hark 的回复收回来（审查意见 X1）。
              settled = {
                id, done: true, reply: last.reply, attachReady, mdCards, anchored, mdTotal, warnings,
                uploadNames: Array.isArray(ctx.uploadNames) ? ctx.uploadNames : [],
              };
              // 卡片宽限期（审查意见 N3）：Hark 的渲染顺序是「文字气泡（结尾是结束标记）
              // → 文件卡片」，卡片要等文件上传完才出现，可能比文字晚一两秒。
              // settle 只保证文字稳定，文字稳定了卡片未必出来——那时 mdCards 还是 0，
              // 就会直接不下载，整条文件通道在 plan/review 上等于没生效。
              // 所以定稿后再多等一会儿，期间卡片一出现就立刻结束，不必等满。
              //
              // 只对 plan/review 宽限，chat 模式保持原来的响应速度：
              // 闲聊不需要文件，多等 8 秒纯属浪费。
              if (wantsFile && mdCards === 0 && anchored) {
                if (!graceUntil) graceUntil = Date.now() + c.attachGraceMs;
                if (Date.now() < graceUntil) {
                  // 还在宽限期内，继续轮询（上界仍是 deadline）。
                  // 注意 settled 已经记下了——宽限期到了却没等到卡片，也一样算成功。
                } else {
                  finished = settled;
                  break;
                }
              } else {
                // 回复已定稿。这里**先退出轮询循环**再下载（审查意见 S1）：
                // 早先是就地 await #withAttachment，那时 ask 子进程还在每秒读整页、
                // 而下载脚本同时在同一标签页滚动点卡片，两个 ego 进程抢一个页面。
                // break 之后 finally 会写 stop 文件、杀掉 ask 的进程树，下载才独占页面。
                finished = settled;
                break;
              }
            }
          } else {
            doneAt = 0;
            graceUntil = 0;
            // 结束标记又不见了（Hark 在补写正文）：之前记的定稿作废。
            settled = null;
          }
        }
        if (Date.now() > deadline) break;
      }
    } catch (e) {
      if (e.name === 'EgoStageError' && e.stage === 'focus') throw loginError();
      if (e.name === 'EgoStageError' && e.stage === 'send') {
        throw new Error('消息已填入但未能发送：请在配置里填写 sendSelector');
      }
      // 文字已经定稿、只是在等卡片时出的错（审查意见 拍板 1）：
      // 宽限期内读页抛错、ego 连续 5 次失败、streamScript 的 timeoutMs 抢先触发，
      // 都会走到这里。这时回复其实已经完整拿到手了，把它报成失败等于让用户重跑
      // 一次几十秒的对话，只为了一张拿不到的卡片。
      // AbortError 除外：那是用户主动取消，必须原样上抛。
      if (settled && e?.name !== 'AbortError') {
        settled.warnings.push(`回复已定稿，但等待附件卡片时出错：${e?.message || e}`);
        return await this.#withAttachment(c, settled, ctx.attachmentSavePath, signal);
      }
      throw e;
    }

    // 定稿后（循环已退出、子进程已被 finally 收掉）再下载附件。
    // settled 也算：宽限期里 poll 流提前结束（测试里的假 ego 只推有限几次）、
    // 或者刚好撞上 timeoutMin，都不改变「文字已经完整」这个事实，
    // 只是卡片还没等到——那就按「没有附件」处理，绝不能报超时。
    const out = finished || settled;
    if (out) return await this.#withAttachment(c, out, ctx.attachmentSavePath, signal);

    // 超时不能当成功返回：模型会把半截方案当成完整结论继续干活。
    const partial = String(last.reply || '').trim();
    const e = new Error(
      `Hark 在 ${c.timeoutMin} 分钟内没有给出结束标记，本次回复未完成，不能当作结论使用。`
      + (partial ? `\n已收到的部分内容（可能被截断，仅供参考）：\n${partial.slice(0, 4000)}` : ''),
    );
    e.name = 'HarkTimeoutError';
    e.partial = partial;
    throw e;
  }

  /**
   * 回复定稿后，把 Hark 附带的 .md 下载到 savePath。
   *
   * 为什么下载失败不能算 ask 失败：回复正文已经拿到了、也完整，那才是调用方真正要的东西；
   * 附件只是"顺手能拿到的额外产物"。为了一张卡片找不到就把整次往返判死，用户要重跑一次
   * 几十秒的对话，代价远大于收益。所以这里只往 warnings 里记一笔。
   */
  async #withAttachment(c, out, savePath, signal) {
    if (!savePath) return out;
    if (c.fetchAttachment === false) return out;
    // 页面有没有卡片，是唯一依据（审查意见 B3）。
    // 早先用「正文够长 + 像 Markdown」猜，可 Hark 气泡显示的是渲染后的内容——
    // 标题没 #、列表符号不进 innerText、代码块没三反引号，猜中概率接近 0，
    // 于是生产上从不下载，e2e 能过只因假页面输出的是原始 Markdown。
    // 现在协议规则要求 Hark 把长内容做成 .md 文件，卡片在不在就是权威答案；
    // 没有卡片（一句话的回复），去找只会翻到别人留下的旧卡片。
    if (!(out.mdCards > 0)) {
      // 页面上确实有卡片、却没一张算在本轮名下：几乎一定是锚点没找到
      // （回复气泡里没找到结束标记，可能被重渲染掉了）。这时**绝不能**退回去取
      // 全页最后一张——那是上一轮的旧审查。留一条 warning 让人能看出发生了什么，
      // 而不是静默地少一个文件。
      if (out.mdTotal > 0) {
        out.warnings.push(
          `页面上有 ${out.mdTotal} 个 .md 附件，但没有一个能确认属于本次回复`
          + '（没找到本次回复的结束标记气泡），为避免取回上一轮的文件，本次不下载。',
        );
      }
      return out;
    }
    if (!out.anchored) {
      // 卡片算得上，但锚点状态没确认过：宁可不下，也不拿错文件。
      out.warnings.push('没找到本次回复的结束标记气泡，为避免取回上一轮的文件，本次不下载附件。');
      return out;
    }
    try {
      const got = await this.#fetchAttachment(c, savePath, signal, endTag(out.id), out.mdCards, out.uploadNames || []);
      if (got?.saved) {
        // 只在真的有内容时加这个键：带上 attachmentReply: undefined 会让调用方
        // 用 `'attachmentReply' in r` 判断时误以为拿到了东西。
        if (typeof got.text === 'string') out.attachmentReply = got.text;
        if (got.name) out.attachmentName = got.name;
        // 落盘位置也要给出来：调用方要能把这个路径写进给模型看的返回值里，
        // 否则模型只知道"有个附件"，不知道去哪儿读。
        if (got.saved) out.attachmentPath = got.saved;
        // 一次回复给了好几个文件时只取了最后一个（审查意见建议 4）。
        // 不能静默：用户以为拿全了，其实少了几份，而少的那份可能正是附表。
        if (out.mdCards > 1) {
          out.warnings.push(
            `本次回复有 ${out.mdCards} 个 .md 附件，只取了最后一个${got.name ? `（${got.name}）` : ''}。`
            + '其余的请到 Hark 页面上手动下载。',
          );
        }
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      out.warnings.push(`附件下载未完成：${e?.message || e}`);
    }
    return out;
  }

  /** 跑独立的第二个脚本：滚到底 → 点开 md 卡片 → 取下载链接 → page.fetch 存盘 */
  async #fetchAttachment(c, savePath, signal, end = '', mdCards = 0, uploadNames = []) {
    const script = buildFetchAttachmentScript({
      origin: c.origin,
      harkUrl: c.harkUrl,
      attachmentSelector: c.attachmentSelector || '',
      end,
      mdCards,
      uploadNames,
      saveAs: savePath,
      browserPath: c.browserPath,
    });
    let saved = null;
    try {
      for await (const ev of this.streamScript(script, {
        exePath: c.browserPath,
        signal,
        timeoutMs: 90_000,
      })) {
        if (ev.phase !== 'attachment') continue;
        if (ev.ok === false) throw new Error(ev.error || '附件下载失败');
        // bytes 以磁盘为准：page.fetch 的返回值各版本字段不一，脚本里能拿到的只是猜测，
        // 而 statSync 拿到的是"这个人现在真的能打开的那个文件"有多少字节。
        let size = Number(ev.bytes);
        try { size = statSync(ev.saved || savePath).size; } catch { /* 拿不到就退回脚本报的数 */ }
        saved = { saved: ev.saved || savePath, name: ev.name || '', bytes: Number.isFinite(size) ? size : 0 };

      }
    } catch (e) {
      // 脚本用 {ok:false,phase:'attachment'} 报告失败，ego 会把它翻成 EgoStageError；
      // 统一改写成普通错误，交给上面的 #withAttachment 记 warning。
      if (e?.name === 'EgoStageError') throw new Error(e.message || '附件下载失败');
      throw e;
    }
    if (!saved) throw new Error('下载脚本没有返回结果');
    let text;
    try { text = readFileSync(saved.saved, 'utf8'); } catch (e) { throw new Error(`读不到下载的文件：${e?.message || e}`); }
    return { ...saved, text };
  }
}

/**
 * 归一化调用方传进来的附件。
 *
 * 只做"能不能用"的判断：staged 是必填的（真正的路径由 attach.js 暂存好），
 * uploadName 缺了就退回 staged 的文件名——上传后页面上显示的就是它，
 * 少了它发送后校验永远对不上。
 */
function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!a || typeof a.staged !== 'string' || !a.staged) continue;
    out.push({
      rel: String(a.rel || ''),
      abs: String(a.abs || ''),
      staged: a.staged,
      uploadName: String(a.uploadName || basename(a.staged)),
      bytes: Number(a.bytes) || 0,
      sha256: String(a.sha256 || ''),
    });
  }
  // 非空却一条都认不出来，说明调用方把契约用错了（比如把路径数组当成品传进来）。
  // 静默丢掉会让用户以为文件发出去了、其实正文里根本没有——必须报错。
  if (!out.length && list.length) {
    throw new AttachError(
      'attachments 需要 stageAttachments() 的产物（每项带 staged 路径）；'
      + '传原始路径请用 attachmentPaths',
    );
  }
  return out;
}

/** 调用方给的路径清单。空/未传都当「没有附件」，不抛错——没附件是正常情况 */
function attachmentPathsOf(opts) {
  const raw = opts?.attachmentPaths;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AttachError('attachmentPaths 必须是字符串数组');
  return raw.filter((p) => typeof p === 'string' && p.trim() !== '');
}

/**
 * 暂存目录：默认放在工作区的 .hark/attach/<请求 id> 下。
 *
 * 带请求 id 而不是固定一个 attach 目录：两次 ask 可能并发（不同会话），
 * 传同名文件时固定目录会互相覆盖，先传上去的那份内容就变成了别人的。
 */
function stageDirOf(opts, id) {
  if (typeof opts?.stageDir === 'string' && opts.stageDir.trim()) return opts.stageDir;
  const root = typeof opts?.workspaceRoot === 'string' ? opts.workspaceRoot.trim() : '';
  if (!root) throw new AttachError('缺少 workspaceRoot（工作区根目录的绝对路径）');
  return join(root, '.hark', 'attach', id);
}

/**
 * 附件清单，附在正文末尾。
 *
 * 为什么需要：上传到 Hark 的文件名被扁平化了（`lib/bridge.js` → `lib__bridge.js`，
 * file input 只接受文件名，目录层级在浏览器那侧不存在）。不给原始相对路径，
 * Hark 看到一串 `lib__x.js`、`test__y.mjs` 只能猜哪个是入口。
 * 大小也写上，让它知道哪个文件值得整篇读、哪个只需要扫一眼。
 */
function manifestSection(files) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return '';
  const lines = list.map((f) => `- ${f.uploadName}（原路径 ${f.rel}，${formatBytes(f.bytes)}）`);
  return ['', '', '## 附件清单', '', ...lines].join('\n');
}

/** 字节数写成 KB/MB：清单是给人看的，12706 不如 12.4 KB 直观 */
function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 把附件正文拼成消息末尾的附注。读不出来的（二进制、文件没了）跳过并记 warning，
 * 绝不因为一个文件坏了就整条请求失败。
 *
 * 用 readFileSync(p,'utf8') 而不是拼 Buffer：内联要的是"人能读的文本"，
 * Buffer 的 toString 会静默替换非法字节，把编码问题伪装成正常内容。
 */
function inlineAttachments(list, warnings) {
  let extra = '';
  for (const a of list) {
    let text;
    try {
      // 读暂存副本而不是 abs：暂存件在复制后复核过 sha256，是「这次请求钉住的快照」；
      // 原文件可能在这几十秒里被别的代理改掉，读它会内联出跟清单对不上的内容。
      text = readFileSync(a.staged, 'utf8');
    } catch (e) {
      warnings.push(`附件 ${a.uploadName} 读取失败，已跳过内联：${e?.message || e}`);
      continue;
    }
    if (text.includes('\u0000')) {
      warnings.push(`附件 ${a.uploadName} 看起来是二进制，已跳过内联`);
      continue;
    }
    extra += `\n\n## 附件 ${a.uploadName}\n\`\`\`\n${text}\n\`\`\``;
  }
  return extra;
}

/** 统一返回值形状：附件相关的字段只在这里拼，避免三处各写一份还写得不一致 */
function finishAsk(id, res, attachMode, attached, warnings) {
  const out = {
    id,
    done: true,
    reply: res.reply,
    attachMode,
    attached,
    warnings: Array.isArray(warnings) ? warnings : [],
  };
  if (typeof res?.attachmentReply === 'string') out.attachmentReply = res.attachmentReply;
  if (res?.attachmentName) out.attachmentName = res.attachmentName;
  // attachmentPath 以前漏了复制（审查意见 B3）：下载明明成功了，返回值里却没有路径，
  // 上层那行「完整回复已保存到 …」永远不出现，模型只拿到气泡里那版渲染后的文本。
  if (res?.attachmentPath) out.attachmentPath = res.attachmentPath;
  return out;
}

function loginError() {
  const e = new Error('找不到 Hark 输入框：请确认已在 ego 里登录 Hark，并且 harkUrl 指向对话页面');
  e.name = 'HarkLoginError';
  return e;
}

function abortError(signal) {
  const why = signal?.reason;
  const e = new Error(why?.message || '已取消');
  e.name = 'AbortError';
  return e;
}

/** 可被 abort 打断的等待 */
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError(signal));
  const onAbort = () => { clearTimeout(t); reject(abortError(signal)); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** 锁心跳间隔：远小于 LOCK_STALE_MS，正常持锁永远不会被误判成残留 */
const LOCK_HEARTBEAT_MS = 60 * 1000;

/**
 * 锁多久没心跳就当残留。
 *
 * 三个心跳周期：一次网络抖动、一次 GC 停顿都跨不过去，而真正卡死的持锁方
 * （进程被强杀、被任务管理器结束、机器休眠）一定跨得过。
 *
 * 为什么不能只靠 pid 判生死（审查意见 S-a）：Windows 的 pid 会被系统复用。
 * 持锁进程被强杀后，它的 pid 很快可能被另一个无关进程占用，`isAlive` 就永远
 * 返回 true，锁再也不会被回收——之后每一次 ask 都要白等满 2 分钟然后报
 * 「另一个 DSH 会话正在和 Hark 对话」。心跳时间戳是 pid 复用骗不过去的判据。
 */
const LOCK_STALE_MS = 3 * LOCK_HEARTBEAT_MS;

function lockPath(dir) {
  return join(dir || dataDir(), 'bridge.lock');
}

/**
 * 跨进程互斥：保证同一时刻只有一个进程在往 Hark 页面里打字。
 *
 * 用 O_EXCL 创建锁文件（openSync 'wx'）拿锁，内容是 {pid, token, at}。
 *
 * 为什么要 token（审查意见 B1）：早先 release 只是无条件 rmSync。一个长请求被误判
 * 成残留、锁被别人拿走之后，原来那个进程结束时会把**别人的锁**删掉，于是第三个
 * 进程畅通无阻地进来。现在每次拿锁生成随机 token，release 前先核对还是不是自己的。
 *
 * 为什么要心跳：抢锁方靠「持有者还活着吗」判断残留。但只靠 pid 不够——
 * Windows 上 pid 会被系统复用，持锁进程被强杀后它的 pid 可能立刻被别的进程占用，
 * 于是锁永远不被回收（审查意见 S-a）。心跳让 mtime 一直很新，抢锁方用
 * 「pid 已死 **或** 心跳停了三个周期」判定残留，pid 复用骗不过时间戳。
 * 顺带能在锁已被接管时让持锁方自己知道（lost），别再续命。
 *
 * 拿不到就每 200ms 重试，同时：
 *   - signal 被取消立刻抛 AbortError，不等；
 *   - 持有者的 pid 已经不在，或心跳超过 LOCK_STALE_MS 没更新 → 视为崩溃残留，删掉重抢；
 *   - pid 读不出来且超过 LOCK_STALE_MS 没动 → 同上。
 *
 * @returns {Promise<() => void>} 释放函数
 */
export async function acquireLock(dir, signal) {
  const file = lockPath(dir);
  const startedAt = Date.now();
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /** 读锁文件内容；打不开或内容坏了返回 null */
  const readLock = () => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  };

  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw abortError(signal);
    try {
      const fd = openSync(file, 'wx');
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }));
      } finally { closeSync(fd); }

      // 心跳：定期把 at/mtime 顶新；同时探测锁是否已被别人接管。
      let lost = false;
      const beat = setInterval(() => {
        const cur = readLock();
        if (cur?.token !== token) { lost = true; clearInterval(beat); return; }
        try {
          writeFileSync(file, JSON.stringify({ pid: process.pid, token, at: Date.now() }));
        } catch { /* 写不了就等下一拍，真丢了锁由 release 的 token 校验兜住 */ }
      }, LOCK_HEARTBEAT_MS);
      // 别让心跳把进程钉住：Node 默认会等 setInterval，unref 之后进程能正常退出。
      if (typeof beat.unref === 'function') beat.unref();

      let released = false;
      return () => {
        clearInterval(beat);
        if (released) return;
        released = true;
        // 只删自己的锁（审查意见 B1）。锁被别人接管后这里不能动手，
        // 否则等于替对方解锁，第三个进程就能同时进来。
        if (lost) return;
        const cur = readLock();
        if (cur && cur.token !== token) return;
        try { rmSync(file, { force: true }); } catch { /* 别人已经删了 */ }
      };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }

    // 抢不到：判断持有者还在不在
    const info = readLock();
    const holderPid = Number(info?.pid) || 0;
    let age = 0;
    try { age = Date.now() - statSync(file).mtimeMs; } catch { /* 刚被删，下一轮重试 */ }

    if (holderPid > 0) {
      // pid 活着 **且** 心跳还新，才认定持有者正常。
      //
      // 两个条件都要（审查意见 S-a）：pid 会被系统复用，光看 pid 会死锁；
      // 光看 mtime 又会把超长请求误判成残留（timeoutMin 上限 120 分钟，
      // 一个 20 分钟的请求完全正常）。心跳每 60 秒顶一次，正常持锁永远年轻。
      const stale = age > LOCK_STALE_MS;
      if (!isAlive(holderPid) || stale) {
        try { rmSync(file, { force: true }); } catch { /* 下一轮重试 */ }
        continue;
      }
    } else if (age > LOCK_STALE_MS) {
      // pid 读不出来（内容坏了/写了一半）才退回看时间。
      try { rmSync(file, { force: true }); } catch { /* 下一轮重试 */ }
      continue;
    }

    // 等一会儿再来；超过 2 分钟还没轮到就报错，别无声卡着。
    if (Date.now() - startedAt > 120_000) {
      throw new Error('另一个 DSH 会话正在和 Hark 对话，等了 2 分钟还没轮到。请稍后再试');
    }
    await sleep(200 + Math.min(attempt, 10) * 50, signal);
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}
