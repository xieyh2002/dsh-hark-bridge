/**
 * lib/selectors.js 的回归测试。
 *
 * 这一层存在的唯一理由，是「别人第一次装、界面不是中文」时不要静默超时。
 * 所以测试的重点不是「能匹配上」，而是**中英文都要匹配上**，以及
 * 「文案换了还能靠 .md 抠出文件名」这条兜底真的管用。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SEL, TEXT, nameFromLabel } from '../lib/selectors.js';

const name = (label) => nameFromLabel(label, TEXT.previewOpen, TEXT.previewClose, TEXT.markdown);

test('发送按钮的文案锚点中英文都认', () => {
  for (const s of ['发送', 'Send message', 'Send', '提交', 'Submit']) {
    assert.equal(TEXT.send.test(s), true, `应认出「${s}」`);
  }
  // 空输入时 Hark 把同一个按钮变成「开始听写」/ "Start dictation"，这时按下去消息不会发出去
  for (const s of ['开始听写', 'Start dictation', 'Stop', '']) {
    assert.equal(TEXT.send.test(s), false, `不该把「${s}」当成发送`);
  }
});

test('中文卡片名：剥掉「打开 … 的预览」', () => {
  assert.equal(name('打开 改锁方案.md 的预览'), '改锁方案.md');
  assert.equal(name('打开 dsh-hark-bridge-0.8-改进方案.md 的预览'), 'dsh-hark-bridge-0.8-改进方案.md');
});

test('英文卡片名：剥掉 "Open preview of …"', () => {
  assert.equal(name('Open preview of plan.md'), 'plan.md');
  assert.equal(name('Open plan.md preview'), 'plan.md');
  assert.equal(name('Open preview of dsh-hark-bridge-0.8-plan.md'), 'dsh-hark-bridge-0.8-plan.md');
});

test('没见过的措辞也能靠 .md 抠出文件名', () => {
  // 这条是兜底：Hark 换文案时前后缀剥不掉，但文件名本身还在 label 里
  assert.equal(name('查看 方案.md 详情'), '方案.md');
  assert.equal(name('方案.md'), '方案.md');
  assert.equal(name('preview: 仓库审查意见.md'), '仓库审查意见.md');
});

test('文件名里带空格、点、横线、中文都不截断', () => {
  assert.equal(name('打开 a b.js.md 的预览'), 'a b.js.md');
  assert.equal(name('打开 中文 名.md 的预览'), '中文 名.md');
  assert.equal(name('Open preview of v0.8.0-notes.md'), 'v0.8.0-notes.md');
});

test('不是 .md 的卡片不算', () => {
  for (const s of ['打开 图.png 的预览', 'Open preview of diff.txt', '发送', '']) {
    assert.equal(TEXT.markdown.test(name(s)), false, `不该把「${s}」当成 md 附件`);
  }
});

test('结构锚点优先用 data-testid，Hark 改文案时不受影响', () => {
  assert.equal(SEL.bubble, '[data-testid=message-bubble]');
  assert.equal(SEL.sendButton, 'button[data-testid=send-button]');
  // 附件卡片允许是 <a> 或 role=button：Hark 把 button 换成链接也很自然
  assert.ok(SEL.card.includes('a[aria-label]'), '卡片选择器要覆盖 <a>');
  assert.ok(SEL.card.includes('[role=button]'), '卡片选择器要覆盖 role=button');
});

test('空输入时的「开始听写」是语音输入态，不是未知文案', () => {
  // 实测 Hark 中文界面：同一个 button[data-testid=send-button] 在输入框为空时
  // aria-label 是「开始听写」，有内容（或挂了附件）时才变成「发送消息」。
  // 自检必须能区分「这一刻没有待发消息」和「文案没见过」——后者才需要用户报 issue。
  for (const label of ['开始听写', 'Start dictation', 'Dictation', 'Stop dictation']) {
    assert.equal(TEXT.send.test(label), false, `${label} 不能当发送按钮`);
    assert.equal(TEXT.dictation.test(label), true, `${label} 要认成语音输入态`);
  }
  for (const label of ['发送消息', 'Send message', 'Submit', '提交']) {
    assert.equal(TEXT.dictation.test(label), false, `${label} 不是语音输入态`);
  }
});
