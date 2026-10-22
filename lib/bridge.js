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
import { closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AttachError, cleanupStaging, collectAttachments, stageAttachments } from './attach.js';
import { runEgoScript, streamEgoScript } from './ego.js';
import { newRequestId, buildMessage, buildRulesBody, extractReply, footTag, RULES_VERSION } from './protocol.js';
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
const FIND_MD_CARD = (selector, foot) => `(() => {
  const sel = ${js(selector)};
  const foot = ${js(foot || '')};
  const all = sel ? [...document.querySelectorAll(sel)] : [...document.querySelectorAll('button[aria-label]')];
  const name = (b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/^\\s*打开\\s*/, '').replace(/\\s*的预览\\s*$/, '').trim();
  const hit = sel ? all : all.filter((b) => /\\.md$/i.test(name(b)));
  if (!hit.length) return null;
  // 只认「本次请求之后、Hark 那条回复里」的卡片。
  // 不这么筛的话会抓到自己刚上传的附件：页面里用户气泡同样挂着 md 卡片（就是上传的那个文件），
  // 取最后一个就会把它当成 Hark 的回复下载下来，attachmentReply 变成自己发的原文——
  // 看起来一切正常，实际是假的。
  const bubbles = [...document.querySelectorAll('[data-testid=message-bubble]')];
  let startAt = -1;
  if (foot) {
    for (let i = 0; i < bubbles.length; i += 1) {
      if ((bubbles[i].innerText || '').indexOf(foot) >= 0) startAt = i;
    }
  }
  let el = null;
  for (const b of hit) {
    const bub = b.closest('[data-testid=message-bubble]');
    if (!bub) continue;
    const idx = bubbles.indexOf(bub);
    // foot 为空（老调用方）时不按位置筛，保持原来的「取最后一个」。
    if (startAt >= 0 && idx <= startAt) continue;
    // 用户那条气泡里有 footTag，回复里只有 endTag；带 foot 的一律是请求本身。
    if (foot && (bub.innerText || '').indexOf(foot) >= 0) continue;
    el = b;
  }
  if (!el) return null;
  el.setAttribute('data-dsh-md', '1');
  return name(el);
})()`;

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
    staged,
    uploadNames: names,
    focus: FOCUS_INPUT(cfg.inputSelector),
    inputLen: INPUT_LEN,
    clickSend: CLICK_SEND(cfg.sendSelector),
    pageText: PAGE_TEXT,
    markFileInput: MARK_FILE_INPUT(cfg.fileInputSelector || ''),
    attachReady: ATTACH_READY(cfg.inputSelector || '', names),
    bubbleText: USER_BUBBLE_TEXT(cfg.foot),
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

if (C.staged.length) {
  // 为什么必须 reload 而不是就地清空：上一次失败的 ask 可能在 composer 里留下
  // 附件 chip，Hark 不会因为「这次没选文件」就把它们丢掉——不刷新，残留会跟着
  // 这条消息一起发出去，用户看到的就是「我只问了一句，它却收到了上次的文件」。
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  if (!(await waitFocus())) fail('focus');

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
  // 心跳：父进程要靠持续的事件流判断「还没回」「页面丢了」「已经稳定」，
  // 只在 tail 变化时才 emit 会让它在 Hark 沉默时完全静默，一直等到超时。
  // 未变化的轮次不带 text（只是一个小行），避免把长文本反复写进事件文件。
  if (at < 0) {
    // sent:false = 页面上还看不到我们的请求
    if (lastSent !== false) { lastSent = false; lastTail = null; emit({ phase: 'poll', sent: false, pageLen: raw.length }); }
    else emit({ phase: 'poll', sent: false, pageLen: raw.length, same: true });
  } else {
    const tail = raw.slice(at + C.foot.length);
    if (tail !== lastTail || lastSent !== true) {
      lastSent = true; lastTail = tail;
      emit({ phase: 'poll', sent: true, text: tail, pageLen: raw.length });
    } else {
      emit({ phase: 'poll', sent: true, pageLen: raw.length, same: true });
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
  return `
const C = ${JSON.stringify({
    attachmentSelector: cfg.attachmentSelector || '',
    origin: cfg.origin,
    saveAs: cfg.saveAs,
    name: cfg.name || '',
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
const findExpr = ${JSON.stringify(FIND_MD_CARD(cfg.attachmentSelector || '', cfg.foot || ''))};

let card = null;
const deadline = Date.now() + C.waitMs;
while (!card && Date.now() < deadline) {
  card = await page.evaluate(findExpr).catch(() => null);
  if (!card) await page.waitForTimeout(500);
}
if (!card) { console.log(JSON.stringify({ ok: false, phase: 'attachment', error: '页面上找不到 .md 附件卡片' })); process.exit(0); }

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
        await this.#handshake(opts);
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
    const script = buildAskScript({ ...c, foot: footTag(id), message: buildMessage(id, 'chat', buildRulesBody()) });
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
    if (String(body).length > c.maxChars) {
      throw new Error(`内容 ${String(body).length} 字符，超过上限 ${c.maxChars}，请拆分或只发 diff`);
    }
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

      // 同一份 body 会因为「降级」被发两次，所以脚本按 (id, 正文, 是否带附件) 现拼，
      // 而不是提前拼好一个：内联降级要换掉正文，还得换 id（页面上会留下两条请求，
      // 沿用旧 id 会让 extractReply 看到两份同 id 的区间）。
      const script = (rid, text, withAttach) => buildAskScript({
        ...c,
        foot: footTag(rid),
        message: buildMessage(rid, mode, text),
        staged: withAttach ? list.map((a) => a.staged) : [],
        uploadNames: withAttach ? list.map((a) => a.uploadName) : [],
      });
      const names = list.map((a) => a.uploadName);
      // 清单跟在正文后面：Hark 那边只看到一串扁平文件名（lib__bridge.js），
      // 加上原始相对路径和大小，它才知道哪个文件是哪个、该先读哪个。
      const text = body + manifestSection(list);
      if (signal?.aborted) throw abortError(signal);

      const release = await acquireLock(this.lockDir, signal);
      try {
        if (!list.length) {
          const res = await this.#runAsk(c, id, script(id, text, false), signal, {
            warnings, attachmentSavePath: savePathOf(id),
          });
          return finishAsk(id, res, 'none', [], warnings);
        }
        try {
          const res = await this.#runAsk(c, id, script(id, text, true), signal, {
            warnings, attachmentSavePath: savePathOf(id), uploadNames: names,
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
    if (total > c.maxChars) {
      const e = new Error(
        `附件上传超时，且内容过大无法内联：共 ${total} 字节，超过上限 ${c.maxChars}（${cause?.message || cause}）`,
      );
      e.name = 'HarkAttachError';
      throw e;
    }
    const extra = inlineAttachments(list, warnings);
    const text = body + extra;
    if (text.length > c.maxChars) {
      const e = new Error(
        `附件上传超时，且内容过大无法内联：内联后正文 ${text.length} 字符，超过上限 ${c.maxChars}`,
      );
      e.name = 'HarkAttachError';
      throw e;
    }
    warnings.push(`附件上传未就绪，已降级为正文内联（共 ${list.length} 个文件）`);
    const id = newRequestId();
    const res = await this.#runAsk(c, id, buildAskScript({
      ...c, foot: footTag(id), message: buildMessage(id, mode, text), staged: [], uploadNames: [],
    }), signal, { warnings, attachmentSavePath: savePathOf(id) });
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
              // 下载放在 settle 之后：此刻回复已经定稿，页面上那张 md 卡片也渲染完了；
              // 早一点去点，卡片可能还没出现，只会白等一个超时。
              const out = { id, done: true, reply: last.reply, attachReady, warnings };
              return await this.#withAttachment(c, out, ctx.attachmentSavePath, signal);
            }
          } else {
            doneAt = 0;
          }
        }
        if (Date.now() > deadline) break;
      }
    } catch (e) {
      if (e.name === 'EgoStageError' && e.stage === 'focus') throw loginError();
      if (e.name === 'EgoStageError' && e.stage === 'send') {
        throw new Error('消息已填入但未能发送：请在配置里填写 sendSelector');
      }
      throw e;
    }

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
    // 短回复不取文件：一句「收到」也要走一遍「滚到底→找卡片→点开→下载」的话，
    // 花的是十几秒的额外往返，拿回来的却还是那句「收到」。而且 Hark 在短回复时
    // 根本不会生成 md 卡片，脚本只会在页面上翻到别的卡片（比如自己刚上传的附件），
    // 把不相干的内容当成回复。只有长内容（方案、审查）才值得走文件通道。
    if (!needsMarkdownFile(out.reply, c)) return out;
    try {
      const got = await this.#fetchAttachment(c, savePath, signal, footTag(out.id));
      if (got?.saved) {
        // 只在真的有内容时加这个键：带上 attachmentReply: undefined 会让调用方
        // 用 `'attachmentReply' in r` 判断时误以为拿到了东西。
        if (typeof got.text === 'string') out.attachmentReply = got.text;
        if (got.name) out.attachmentName = got.name;
        // 落盘位置也要给出来：调用方要能把这个路径写进给模型看的返回值里，
        // 否则模型只知道"有个附件"，不知道去哪儿读。
        if (got.saved) out.attachmentPath = got.saved;
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      out.warnings.push(`附件下载未完成：${e?.message || e}`);
    }
    return out;
  }

  /** 跑独立的第二个脚本：滚到底 → 点开 md 卡片 → 取下载链接 → page.fetch 存盘 */
  async #fetchAttachment(c, savePath, signal, foot = '') {
    const script = buildFetchAttachmentScript({
      origin: c.origin,
      harkUrl: c.harkUrl,
      attachmentSelector: c.attachmentSelector || '',
      foot,
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
 * 这次回复值不值得去页面上下载 md 文件。
 *
 * 用户定下的用法：一句话的回答直接读正文，方案和审查这类长内容才走文件。
 * 除了省一次十几秒的往返，更要紧的是准确性——Hark 回一句「收到」时页面上根本
 * 没有它自己生成的卡片，此时去翻卡片只会翻到别人留下的旧卡片，甚至翻到我们
 * 刚上传的附件本身，把不相干的内容当成本次回复（这个坑踩过一次）。
 *
 * 判定同时看长度和结构：光是长也不够，模型偶尔会把长回复直接写在正文里，
 * 那种情况下没有卡片可取，多跑一趟也是白跑。所以「长」和「像文档」两者都满足
 * 才会去找文件。
 */
function needsMarkdownFile(reply, cfg = {}) {
  const text = String(reply ?? '');
  const min = Number.isFinite(cfg.markdownMinChars) ? cfg.markdownMinChars : 1200;
  // 0 表示不看门槛，一律走文件通道（测试和「我就要文件」的场景用这个）。
  if (min === 0) return true;
  if (text.length < min) return false;
  // 有标题、列表、代码块、表格中的任意两样，就认为它是一份文档而不是一段话。
  const signals = [
    /^#{1,6}\s+\S/m,          // Markdown 标题
    /^\s*[-*+]\s+\S/m,        // 无序列表
    /^\s*\d+[.)]\s+\S/m,      // 有序列表
    /^```/m,                  // 代码块
    /^\s*\|.*\|\s*$/m,        // 表格
  ];
  return signals.filter((re) => re.test(text)).length >= 2;
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

/** 锁文件超过这么久没更新，就认为持有者已经死了（比如上一轮被强杀） */
const LOCK_STALE_MS = 10 * 60 * 1000;

function lockPath(dir) {
  return join(dir || dataDir(), 'bridge.lock');
}

/**
 * 跨进程互斥：保证同一时刻只有一个进程在往 Hark 页面里打字。
 *
 * 用 O_EXCL 创建锁文件（openSync 'wx'）拿锁，内容是 {pid, at}。
 * 拿不到就每 200ms 重试，同时：
 *   - signal 被取消立刻抛 AbortError，不等；
 *   - 锁文件的 pid 已经不在了（或文件超过 LOCK_STALE_MS 没动）→ 视为崩溃残留，删掉重抢。
 *
 * @returns {Promise<() => void>} 释放函数
 */
export async function acquireLock(dir, signal) {
  const file = lockPath(dir);
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw abortError(signal);
    try {
      const fd = openSync(file, 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); } finally { closeSync(fd); }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { rmSync(file, { force: true }); } catch { /* 别人已经删了 */ }
      };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }

    // 抢不到：看看是不是残留锁
    let holderPid = 0;
    let age = 0;
    try {
      const info = JSON.parse(readFileSync(file, 'utf8'));
      holderPid = Number(info?.pid) || 0;
    } catch { /* 正在写或内容坏了，当作还活着，下一轮再看 */ }
    try { age = Date.now() - statSync(file).mtimeMs; } catch { /* 刚被删，下一轮重试 */ }

    const holderGone = holderPid > 0 && !isAlive(holderPid);
    if (holderGone || age > LOCK_STALE_MS) {
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
