/**
 * 自检命令的回归测试（对应 Hark 方案 T3）
 *
 * 自检的价值全在「失败时说得出下一步怎么办」，所以这里断言的重点不是
 * ok 的真假，而是 hint 有没有给出可执行的动作——一个只报「失败」的自检
 * 等于没做。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 自检会读锁文件和握手记录，必须指到临时目录，不能碰用户真实配置。
process.env.DSH_HARK_BRIDGE_HOME = mkdtempSync(join(tmpdir(), 'dsh-hark-diag-'));

const { HarkBridge } = await import('../lib/bridge.js');
const { formatDiagnosis } = await import('../lib/index.js');

const byName = (rows, name) => rows.find((r) => r.name === name);

// 注入了假 ego 路径：CI 机器上没装 ego，不注入的话「ego-browser」必然失败，
// 后面所有页面锚点的用例都跑不到，等于这些逻辑在 CI 里从没被测过。
const FAKE_EGO = '/fake/ego-browser';
const egoFound = () => FAKE_EGO;
const egoMissing = () => null;

// ---- 1. 没设 harkUrl：只报到地址这一项，并给出设置命令 ----
{
  const b = new HarkBridge(() => ({}), { findEgo: egoFound, runScript: async () => { throw new Error('不该开浏览器'); } });
  const rows = await b.diagnose();
  const url = byName(rows, 'harkUrl');
  assert.equal(url.ok, false, '没地址必须报失败');
  assert.ok(url.hint.includes('/hark-url'), '提示里要给设置命令，不能只说「没设置」');
  assert.equal(byName(rows, '页面'), undefined, '没地址就不该去开浏览器');
  console.log('ok   没设地址时只报地址，且给 /hark-url 提示');
}

// ---- 2. 有地址但 ego 找不到：要提示装 ego 或填 browserPath ----
{
  const b = new HarkBridge(
    () => ({ harkUrl: 'https://hark.example.com/p/1', browserPath: join(tmpdir(), 'no-such-ego.exe') }),
    { findEgo: egoMissing, runScript: async () => { throw new Error('不该开浏览器'); } },
  );
  const rows = await b.diagnose();
  const ego = byName(rows, 'ego-browser');
  assert.equal(ego.ok, false, '找不到 ego 必须报失败');
  assert.equal(typeof ego.detail, 'string');
  assert.ok(ego.hint.includes('browserPath'), '找不到时要提 browserPath');
  assert.equal(byName(rows, '页面'), undefined, '没 ego 就不该尝试开浏览器');
  console.log('ok   ego 找不到时报失败并提示 browserPath，且不再尝试开浏览器');
}

// ---- 3. 握手未完成：算「不算错」，但要说明下次会多花一轮 ----
{
  const b = new HarkBridge(() => ({ harkUrl: 'https://hark.example.com/p/1' }), {
    findEgo: egoFound,
    runScript: async () => ({ ok: true }),
  });
  const rows = await b.diagnose();
  const hs = byName(rows, '握手');
  assert.equal(hs.ok, null, '没握手不是错误');
  assert.ok(hs.hint.includes('自动握手'), '要说清下次会自动做，不用手动');
  console.log('ok   未握手算「注意」不算错，并说明会自动握手');
}

// ---- 4. 锁被活着的进程占着：报失败并说明会排队 ----
{
  const dir = process.env.DSH_HARK_BRIDGE_HOME;
  const { writeFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const url = 'https://hark.example.com/p/1';
  // 锁名按地址分开，测试必须写同一个名字，否则自检读到的是别的文件。
  const lockFile = join(dir, `bridge-${createHash('sha256').update(url).digest('hex').slice(0, 8)}.lock`);
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 't', at: Date.now() }));
  const b = new HarkBridge(() => ({ harkUrl: url }), {
    findEgo: egoFound,
    runScript: async () => ({ ok: true }),
    lockDir: dir,
  });
  const rows = await b.diagnose();
  const lock = byName(rows, '锁');
  assert.equal(lock.ok, false, '被活着的人占着要报失败');
  assert.ok(lock.hint.includes('3 分钟'), '要说清什么时候会自动回收');
  const { rmSync } = await import('node:fs');
  rmSync(lockFile, { force: true });
  console.log('ok   锁被占用时报失败，并说明自动回收时机');
}

// ---- 5. 页面探测：锚点全命中时不报错 ----
{
  const b = new HarkBridge(() => ({ harkUrl: 'https://hark.example.com/p/1' }), {
    findEgo: egoFound,
    runScript: async () => ({
      ok: true,
      url: 'https://hark.example.com/p/1',
      bubbles: 6,
      cards: 0,
      inputs: 1,
      sendButtons: 1,
      sendLabel: 'Send message',
      lang: 'en',
    }),
  });
  const rows = await b.diagnose();
  assert.equal(byName(rows, '页面').ok, true);
  assert.equal(byName(rows, '消息气泡').ok, true);
  assert.equal(byName(rows, '输入框').ok, true);
  const send = byName(rows, '发送按钮');
  assert.equal(send.ok, true, '英文界面的 Send message 必须认');
  assert.ok(send.detail.includes('en'), '要把界面语言报出来，方便定位语言不匹配');
  assert.equal(byName(rows, '附件卡片').ok, null, '没有卡片不算错');
  console.log('ok   页面锚点全命中，英文界面也认');
}

// ---- 6. 页面探测：没见过的界面文案要报失败，并带出 aria-label 原文 ----
{
  const b = new HarkBridge(() => ({ harkUrl: 'https://hark.example.com/p/1' }), {
    findEgo: egoFound,
    runScript: async () => ({
      ok: true,
      url: 'https://hark.example.com/p/1',
      bubbles: 3,
      cards: 0,
      inputs: 1,
      sendButtons: 1,
      sendLabel: 'Absenden',
      lang: 'de',
    }),
  });
  const rows = await b.diagnose();
  const send = byName(rows, '发送按钮');
  assert.equal(send.ok, false, '没见过的文案要报失败');
  assert.ok(send.detail.includes('Absenden'), 'detail 必须带 aria-label 原文，用户才能复制给我们');
  assert.ok(send.hint.includes('sendSelector'), '要给绕过办法');
  console.log('ok   未知界面语言时把 aria-label 原文带出来，并给 sendSelector 兜底');
}

// ---- 6b. 空输入时按钮是「开始听写」：不算失败，但要说明原因 ----
{
  const b = new HarkBridge(() => ({ harkUrl: 'https://hark.example.com/p/1' }), {
    findEgo: egoFound,
    runScript: async () => ({
      ok: true,
      url: 'https://hark.example.com/p/1',
      bubbles: 6,
      cards: 0,
      inputs: 1,
      sendButtons: 1,
      sendLabel: '开始听写',
      lang: 'zh-CN',
    }),
  });
  const rows = await b.diagnose();
  const send = byName(rows, '发送按钮');
  assert.equal(send.ok, null, '空输入的语音输入态是「注意」不是「失败」');
  assert.ok(send.detail.includes('开始听写'), 'detail 要带原文');
  assert.ok(send.detail.includes('空输入'), '要解释为什么会显示成语音输入');
  assert.equal(send.hint, undefined, '这不是错误，不该给「去改配置」的提示');
  console.log('ok   空输入时显示「开始听写」算注意，不误导用户去改配置');
}

// ---- 7. 页面打不开：不能把前面的结论一起吞掉 ----
{
  const b = new HarkBridge(() => ({ harkUrl: 'https://hark.example.com/p/1' }), {
    findEgo: egoFound,
    runScript: async () => { throw new Error('ego 调用失败：没有输出'); },
  });
  const rows = await b.diagnose();
  const page = byName(rows, '页面探测');
  assert.equal(page.ok, false);
  assert.ok(page.detail.includes('没有输出'), '要把底层错误原样带出来');
  assert.ok(byName(rows, 'harkUrl'), '前面的结论必须还在');
  console.log('ok   页面打不开时仍保留前面的检查结果');
}

// ---- 8. detectHarkTabs：只挑像 Hark 对话页的标签页 ----
{
  const b = new HarkBridge(() => ({}), {
    runScript: async () => ({
      ok: true,
      tabs: [
        { url: 'https://hark.com/project/abc', title: '我的项目' },
        { url: 'https://hark.com/project/abc', title: '我的项目（重复）' },
        { url: 'chrome://settings', title: '设置' },
        { url: 'https://example.com/x', title: '别站' },
        { url: 'https://sub.hark.example.org/chat', title: '自建部署' },
        { url: '', title: '空' },
      ],
    }),
  });
  const tabs = await b.detectHarkTabs();
  assert.equal(tabs.length, 2, `应当只留两个 Hark 页面，实际 ${tabs.map((t) => t.url).join(',')}`);
  assert.ok(tabs.every((t) => /hark/i.test(t.url)), '只留站点名含 hark 的');
  assert.equal(tabs[0].url, 'https://hark.com/project/abc');
  console.log('ok   detectHarkTabs 只挑 Hark 页、去重、跳过浏览器内部页');
}

// ---- 9. detectHarkTabs：ego 连不上时返回空数组，不能抛 ----
{
  const b = new HarkBridge(() => ({}), {
    runScript: async () => { throw new Error('no browser'); },
  });
  await assert.rejects(b.detectHarkTabs(), /no browser/, '探测失败要上抛，让调用方决定怎么提示');
  console.log('ok   detectHarkTabs 失败时上抛（调用方自己决定是否静默）');
}

// ---- 10. formatDiagnosis 的三态与收尾 ----
{
  const text = formatDiagnosis([
    { name: 'ego-browser', ok: true, detail: 'C:\\ego.exe' },
    { name: '输入框', ok: false, detail: '命中 0 个', hint: '先 /hark-login 登录' },
    { name: '附件卡片', ok: null, detail: '当前页面命中 0 个' },
  ]);
  assert.ok(text.includes('✅ ego-browser'), '通过项要有对勾');
  assert.ok(text.includes('❌ 输入框'), '失败项要有叉');
  assert.ok(text.includes('→ 先 /hark-login 登录'), 'hint 要缩进显示');
  assert.ok(text.includes('有 1 项没通过'), '收尾要数出失败项数量');
  assert.ok(!text.includes('→ undefined'), '没有 hint 的项不能印出 undefined');

  const allOk = formatDiagnosis([{ name: 'a', ok: true, detail: 'b' }]);
  assert.ok(allOk.includes('全部通过'), '全通过时要说全通过');
  assert.equal(formatDiagnosis([]), '自检没有返回任何结果，请把这条命令的输出发给维护者。');
  console.log('ok   formatDiagnosis 三态、hint、收尾都对');
}

console.log('\ndiag tests passed');
