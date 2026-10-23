// 用真实 Hark 页面的 DOM 快照测页面表达式。
//
// 为什么需要这个文件：e2e 的假页面是照我们对 Hark 的理解写的。Hark 一改版，
// 假页面照旧、CI 照旧全绿，而真机上插件已经瞎了——这种失败只有用户能发现。
// `test/fixtures/hark-conversation.html` 是真页面抓下来的结构，
// 页面表达式在这里跑得通，才说明它面对真实 DOM 是活的。
//
// 夹具怎么更新：`node scripts/capture-fixture.mjs`（需要 ego 在跑）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { PAGE_EXPR } from '../lib/bridge.js';
import { SEL, TEXT } from '../lib/selectors.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'hark-conversation.html');
const html = readFileSync(FIXTURE, 'utf8');

/**
 * 把夹具装进 jsdom，并在那个 window 里跑一段页面表达式。
 *
 * 表达式是 `(() => {...})()` 形式的字符串，`page.evaluate()` 在真机上也是这么跑的，
 * 所以 `new Function` 在这里是等价还原，不是取巧。
 */
function run(expr, { url = 'https://hark.com/project/00000000-0000-0000-0000-000000000000' } = {}) {
  // `runScripts: 'outside-only'`：给 window 一个真正属于它的 eval，但**不执行**
  // 页面里的 <script>（夹具带着 Hark 自己的 8 段脚本，跑起来既慢又不可控）。
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  // 真机上 `innerText` 是布局相关属性，jsdom 不实现；用 textContent 顶上——
  // 对「气泡里有没有这段文字」这类判断，两者等价。
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent || ''; },
    configurable: true,
  });
  // 表达式里用到 getBoundingClientRect / getComputedStyle 判断可见性；jsdom 全返回 0，
  // 会把所有元素判成不可见。给一个非零尺寸，让「可见性」这道门不误杀。
  window.Element.prototype.getBoundingClientRect = function rect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 16 };
  };
  // 必须用 window.eval 而不是 new Function：Function 的全局作用域是 Node 的，
  // 表达式里的 document / window / Node 全找不到。
  const out = window.eval(`(${expr})`);
  dom.window.close();
  return out;
}

test('夹具本身要有对话结构，否则下面全是空跑', () => {
  // 直接把选择器形状拼回 HTML 里找：夹具是 outerHTML，属性带引号。
  assert.ok(html.includes('data-testid="message-bubble"'), '夹具里应该有 message-bubble');
  assert.ok(html.length > 50_000, `夹具太小了（${html.length} 字符），是不是抓早了`);
});

test('真实页面上能数到消息气泡（核心锚点没变）', () => {
  const n = run(`document.querySelectorAll(${JSON.stringify(SEL.bubble)}).length`);
  assert.ok(n > 0, `真实页面里 ${SEL.bubble} 命中 0 个——Hark 改版了，插件已经瞎了`);
});

test('真实页面上找得到输入框和发送按钮', () => {
  assert.ok(run(`document.querySelectorAll(${JSON.stringify(SEL.input)}).length`) > 0, '输入框锚点失效');
  assert.ok(run(`document.querySelectorAll(${JSON.stringify(SEL.sendButton)}).length`) > 0, '发送按钮锚点失效');
});

test('真实页面的发送按钮文案认得出来（或是空输入的语音输入态）', () => {
  const label = run(`document.querySelector(${JSON.stringify(SEL.sendButton)}).getAttribute('aria-label') || ''`);
  const isSend = TEXT.send.test(label);
  const isDictation = TEXT.dictation.test(label);
  assert.ok(isSend || isDictation,
    `真实页面的 aria-label 是 "${label}"，既不像发送也不像语音输入——需要更新 TEXT`);
});

test('真实页面上的文件卡片能抠出文件名', () => {
  const names = run(`[...document.querySelectorAll(${JSON.stringify(SEL.card)})]
    .map((b) => b.getAttribute('aria-label') || '')
    .filter((s) => /[.](md|diff|ts|js|json|txt|yml)$/i.test(s.replace(/\\s*(?:的预览|preview)\\s*$/i, '').trim()))`);
  assert.ok(Array.isArray(names), '至少能选中一批候选卡片');
  // 夹具里有 .md 和 .diff 卡片，说明这一类结构确实存在
  assert.ok(names.length > 0, `真实页面里没有一张带文件名的卡片；夹具可能抓的是空对话`);
});

test('MD_CARD_EXPR 在真实 DOM 上认得出本次回复的卡片', () => {
  const end = '[[DSH-END#fixture1]]';
  const counted = run(PAGE_EXPR.countMdCards(SEL.card, end, []));
  const info = JSON.parse(counted);
  assert.equal(info.anchored, true, '夹具里有结束标记，应该能锚定到它所在的气泡');
  assert.ok(info.count > 0,
    `锚定成功却数到 0 张卡片（total=${info.total}）——位置筛条件在真实布局下失效了`);
  assert.ok(info.total >= info.count, 'total 是筛选前的总数，不该小于 count');
});

test('MD_CARD_EXPR 在真实 DOM 上能取到卡片名，且不会取到自己上传的那张', () => {
  const end = '[[DSH-END#fixture1]]';
  const name = run(PAGE_EXPR.findMdCard(SEL.card, end, []));
  assert.equal(typeof name, 'string');
  assert.match(name, /\.(md|diff|ts|js|json|txt|yml)$/i, `取到的卡片名不像文件名：${name}`);

  // 把这张卡片的文件名当成「我自己刚上传的」排掉，应该换一张或取不到——
  // 但绝不能还是同一个名字（那就是 X1 那个 bug 复发了）。
  const excluded = run(PAGE_EXPR.findMdCard(SEL.card, end, [name]));
  assert.notEqual(excluded, name, '排除了自己上传的文件名之后，不该还取到它');
});

test('真实页面上找得到本次请求的气泡（发送后校验的前提）', () => {
  const text = run(PAGE_EXPR.bubbleText('[DSH#fixture1]'));
  assert.ok(typeof text === 'string' && text.includes('[DSH#fixture1]'),
    '没找到带本次请求编号的气泡：USER_BUBBLE_TEXT 的前提在真实页面上不成立');
});

test('ATTACH_READY 在真实 DOM 上不抛错，并给出可判定的结构', () => {
  const r = run(PAGE_EXPR.attachReady(SEL.inputSelector || '', ['fixture-1.md']));
  assert.ok(r && typeof r === 'object', 'ATTACH_READY 应该返回对象');
  assert.equal(typeof r.found, 'boolean');
  // 没在输入框里挂附件，所以 hits 应该是 0；这里只验形状与不崩。
  if (r.found) {
    assert.equal(typeof r.hits, 'number');
    assert.equal(typeof r.needed, 'number');
    assert.equal(typeof r.sendOk, 'boolean');
  }
});
