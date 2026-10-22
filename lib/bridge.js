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
import { join } from 'node:path';
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
 * ask 用的完整脚本：选页 → 等输入框 → 打字回车 → 无限轮询页面文本。
 * 轮询不会自己停，父进程判定完成后直接 kill 子进程。
 *
 * 轮询只回传 footTag 之后的部分（审查意见 B3）：Hark 页面越长，整页 innerText
 * 越大（几十上百 KB），逐轮全量回传会让事件文件与父进程解析都变成 O(n²)；
 * 我们要的回复区间本来就在 footTag 之后。页面没变化时不回传，父进程有超时兜底。
 */
function buildAskScript(cfg) {
  return `
const C = ${JSON.stringify({
    inputSelector: cfg.inputSelector || '',
    sendSelector: cfg.sendSelector || '',
    loginWaitSec: cfg.loginWaitSec,
    pollMs: cfg.pollMs,
    message: cfg.message,
    foot: cfg.foot,
    focus: FOCUS_INPUT(cfg.inputSelector),
    inputLen: INPUT_LEN,
    clickSend: CLICK_SEND(cfg.sendSelector),
    pageText: PAGE_TEXT,
  })};
const emit = (o) => console.log(JSON.stringify({ ok: true, ...o }));

${PICK_PAGE(cfg.origin, cfg.harkUrl)}

const deadline = Date.now() + C.loginWaitSec * 1000;
let focused = false;
while (Date.now() < deadline) {
  focused = await page.evaluate(C.focus).catch(() => false);
  if (focused) break;
  await page.waitForTimeout(1000);
}
if (!focused) { console.log(JSON.stringify({ ok: false, phase: 'focus' })); process.exit(0); }

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
  }
  await page.waitForTimeout(C.pollMs);
}
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

  async #ask(mode, body, { signal } = {}) {
    const c = this.#config();
    if (String(body).length > c.maxChars) {
      throw new Error(`内容 ${String(body).length} 字符，超过上限 ${c.maxChars}，请拆分或只发 diff`);
    }
    const id = newRequestId();
    const script = buildAskScript({ ...c, foot: footTag(id), message: buildMessage(id, mode, body) });
    if (signal?.aborted) throw abortError(signal);

    const release = await acquireLock(this.lockDir, signal);
    try {
      return await this.#runAsk(c, id, script, signal);
    } finally {
      release();
    }
  }

  async #runAsk(c, id, script, signal) {
    const deadline = Date.now() + c.timeoutMin * 60_000;
    const sendDeadline = Date.now() + 30_000;
    let last = { status: 'not-sent', reply: '' };
    let sentSeen = false;
    let doneAt = 0;
    let emptySince = 0;

    try {
      for await (const ev of this.streamScript(script, {
        exePath: c.browserPath,
        signal,
        timeoutMs: c.timeoutMin * 60_000 + 30_000,
      })) {
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
            if (Date.now() - doneAt >= c.settleMs) return { id, done: true, reply: last.reply };
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
