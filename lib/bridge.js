/**
 * HarkBridge：打开 Hark 网页 → 发送消息 → 等待带结束标记的回复
 *
 * 浏览器层直接用用户自己的 ego（通过 `ego-browser nodejs` 官方通道），
 * 所以登录一次之后一直有效，也不会另开一个没登录的空浏览器。
 */
import { runEgoScript, streamEgoScript } from './ego.js';
import { newRequestId, buildMessage, buildRulesBody, extractReply, footTag, RULES_VERSION } from './protocol.js';
import { readOverride, writeOverride } from './store.js';

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
const task = await taskSpace('hark-bridge');
const tabs = await task.tabs();
let page = null;
for (const t of tabs) {
  if (t.url && ${js(origin)} && t.url.startsWith(${js(origin)})) {
    page = t.label ? await task.page(t.label) : await task.adopt(t.page);
    break;
  }
}
if (!page) { const pages = await task.pages(); page = pages.length ? pages[0] : await task.newPage(); }
const cur = await page.url().catch(() => '');
const want = ${js(url)};
if (!${js(origin)} || !cur.startsWith(${js(origin)}) || cur.split('#')[0] !== want.split('#')[0]) {
  await page.goto(want, { waitUntil: 'domcontentloaded' }).catch(() => {});
}
`;

/**
 * ask 用的完整脚本：选页 → 等输入框 → 打字回车 → 无限轮询页面文本。
 * 轮询不会自己停，父进程判定完成后直接 kill 子进程。
 */
function buildAskScript(cfg) {
  return `
const C = ${JSON.stringify({
    inputSelector: cfg.inputSelector || '',
    sendSelector: cfg.sendSelector || '',
    loginWaitSec: cfg.loginWaitSec,
    pollMs: cfg.pollMs,
    message: cfg.message,
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

while (true) {
  emit({ phase: 'poll', text: await page.evaluate(C.pageText).catch(() => '') });
  await page.waitForTimeout(C.pollMs);
}
`;
}

export class HarkBridge {
  /**
   * @param {() => object} getConfig
   * @param {{ log?: Function, streamScript?: Function, runScript?: Function }} [deps]
   *   streamScript / runScript 允许测试注入假的 ego 通道，生产代码不传。
   */
  constructor(getConfig, deps = {}) {
    this.getConfig = getConfig;
    this.logger = deps.log || console;
    this.streamScript = deps.streamScript || streamEgoScript;
    this.runScript = deps.runScript || runEgoScript;
    this.queue = Promise.resolve();
  }

  /** 把 Hark 页面在用户的 ego 里打开并切到前台，供首次登录 */
  async openForLogin() {
    const c = this.#config();
    const script = `
${PICK_PAGE(c.origin, c.harkUrl)}
await page.cdp('Page.bringToFront', {}).catch(() => {});
console.log(JSON.stringify({ ok: true, url: await page.url().catch(() => '') }));
`;
    const r = await this.runScript(script, { exePath: c.browserPath, timeoutMs: 60_000 });
    return `已在 ego 里打开 ${r.url || c.harkUrl}。如未登录，请在该标签页里登录一次；之后会自动保持登录。`;
  }

  #config() {
    const c = this.getConfig();
    if (!c.harkUrl) throw new Error('还没有设置 Hark 地址：在 DSH 里执行 /hark-url https://…（Hark 对话页面的地址）');
    let origin = '';
    try { origin = new URL(c.harkUrl).origin; } catch { throw new Error(`harkUrl 不是合法网址：${c.harkUrl}`); }
    return { ...c, origin };
  }

  /** 串行排队，避免两个请求同时往一个输入框里打字 */
  ask(mode, body, opts = {}) {
    const run = this.queue.then(async () => {
      // 已经取消的请求连握手都不发——用户按了停止，就不该再往 Hark 页面里塞任何东西。
      if (opts.signal?.aborted) throw abortError(opts.signal);
      await this.#handshake(opts);
      return this.#ask(mode, body, opts);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * 首次在该 Hark 页面协作时，先把协议规则完整发一遍。
   *
   * 为什么值得多花一次往返：Hark 不会自己知道结束标记要写成 [[DSH-END#id]]，
   * 不教它就只能靠猜，而猜错的代价是整整等满 timeoutMin 然后拿到一个超时错误。
   *
   * 握手失败不阻断正式请求——Hark 可能已经在这个对话里学会了规则，
   * 真正有没有说上话由紧接着的 #ask 判定。
   */
  async #handshake({ signal } = {}) {
    let c;
    try { c = this.#config(); } catch { return; }
    const done = readOverride().handshakes;
    const seen = done && typeof done === 'object' ? done[c.harkUrl] : undefined;
    if (seen === RULES_VERSION) return;

    const id = newRequestId();
    const script = buildAskScript({ ...c, message: buildMessage(id, 'chat', buildRulesBody()) });
    // 握手只是确认一句「收到」，给它比正式请求更短的预算，失败就往下走。
    const budget = Math.min(c.timeoutMin, 3);
    const startedAt = Date.now();
    try {
      for await (const ev of this.streamScript(script, { exePath: c.browserPath, signal })) {
        if (ev.phase !== 'poll') continue;
        if (extractReply(ev.text, id).status === 'done') {
          this.#rememberHandshake(c.harkUrl);
          return;
        }
        if (Date.now() - startedAt > budget * 60_000) break;
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
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
    const script = buildAskScript({ ...c, message: buildMessage(id, mode, body) });
    if (signal?.aborted) throw abortError(signal);

    const deadline = Date.now() + c.timeoutMin * 60_000;
    const sendDeadline = Date.now() + 30_000;
    let last = { status: 'not-sent', reply: '' };
    let sentSeen = false;

    try {
      for await (const ev of this.streamScript(script, { exePath: c.browserPath, signal })) {
        if (ev.phase === 'poll') {
          last = extractReply(ev.text, id);
          if (last.status !== 'not-sent') sentSeen = true;
          if (!sentSeen && Date.now() > sendDeadline) {
            throw new Error(`30 秒内页面上没出现已发送的消息（${footTag(id)}），发送可能失败`);
          }
          if (last.status === 'done') {
            await sleep(c.settleMs, signal);
            return { id, done: true, reply: last.reply };
          }
        }
        if (Date.now() > deadline) break;
      }
    } catch (e) {
      if (e.name === 'EgoStageError' && e.stage === 'focus') {
        const err = new Error('找不到 Hark 输入框：请确认已在 ego 里登录 Hark，并且 harkUrl 指向对话页面');
        err.name = 'HarkLoginError';
        throw err;
      }
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
