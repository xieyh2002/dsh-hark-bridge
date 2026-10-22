/**
 * 真实链路 e2e：真的通过 ego 打开页面、真的打字回车、真的从页面文本里抓回复。
 *
 * 假 Hark 页面由本脚本自己起 HTTP 服务提供，不碰真实 Hark、不需要外网。
 * 用的是用户正在运行的 ego（ego-browser nodejs 通道），所以会在他浏览器里
 * 临时开一个标签页；跑完关掉。
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 隔离 store：握手记录不能写进用户真实的 %LOCALAPPDATA%\dsh-hark-bridge\settings.json
const TMP_HOME = mkdtempSync(join(tmpdir(), 'dsh-hark-e2e-'));
process.env.DSH_HARK_BRIDGE_HOME = TMP_HOME;

const { HarkBridge } = await import('../lib/bridge.js');
const { findEgoBrowser } = await import('../lib/ego.js');

const PORT = 18941;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const PAGE = [
  '<!doctype html><meta charset="utf-8"><title>Fake Hark</title>',
  '<style>body{font:14px/1.5 system-ui;margin:20px}textarea{width:600px;height:80px}',
  '#log{white-space:pre-wrap;margin-top:16px;border-top:1px solid #ccc;padding-top:12px}</style>',
  '<textarea id="in" placeholder="给 Hark 发消息"></textarea>',
  '<button id="send">发送</button>',
  '<div id="log"></div>',
  '<script>',
  'const ta = document.getElementById("in");',
  'const log = document.getElementById("log");',
  'function send() {',
  '  const text = ta.value;',
  '  if (!text.trim()) return;',
  '  const box = document.createElement("div");',
  '  box.textContent = text;',
  '  log.appendChild(box);',
  '  ta.value = "";',
  '  const m = /\\[DSH#([a-z0-9]+)\\]/.exec(text);',
  '  const id = m ? m[1] : "unknown";',
  '  if (text.includes("NOREPLY")) { window.__trace = "deliberately silent"; return; }',
  '  setTimeout(() => {',
  '    const r = document.createElement("div");',
  '    r.textContent = [',
  '      "收到。这是假 Hark 的自动回复。",',
  '      "",',
  '      "```js",',
  '      "const a = 1;",',
  '      "",',
  '      "",',
  '      "const b = 2;",',
  '      "```",',
  '      "",',
  '      "",',
  '      "结论：链路正常。",',
  '      "[[DSH-END#" + id + "]]",',
  '    ].join("\\n");',
  '    log.appendChild(r);',
  '  }, 500);',
  '}',
  'ta.addEventListener("keydown", (e) => {',
  '  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }',
  '});',
  'document.getElementById("send").addEventListener("click", send);',
  '</script>',
].join('\n');

const pageServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

const config = {
  harkUrl: ORIGIN,
  triggerWords: ['hark'],
  browserPath: findEgoBrowser('') || '',
  inputSelector: '',
  sendSelector: '',
  timeoutMin: 2,
  loginWaitSec: 30,
  pollMs: 300,
  settleMs: 600,
  maxChars: 60000,
};
const getConfig = () => config;

const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

await new Promise((r) => pageServer.listen(PORT, '127.0.0.1', r));
step(`假 Hark 页面已就绪 ${ORIGIN}`);

if (!config.browserPath) {
  console.log('SKIP  没有找到 ego-browser，跳过真实链路测试');
  pageServer.close();
  process.exit(0);
}
step(`使用 ego-browser: ${config.browserPath}`);

const bridge = new HarkBridge(getConfig);
let failed = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`);
  if (!ok) failed++;
};

try {
  // --- 0. 首次握手：第一次 ask 会先发一遍协议规则，假 Hark 会照规矩回一句 ---
  step('开始第一次 ask（会先握手，再发正式请求）');
  const r1 = await bridge.ask('plan', '## 用户原话\n加一个导出功能');
  step(`收到回复，${r1.reply.length} 字符`);
  check('返回 done=true', r1.done === true);
  check('回复包含自动回复正文', r1.reply.includes('假 Hark 的自动回复'));
  check('回复包含结论', r1.reply.includes('结论：链路正常'));
  check('回复里不含结束标记', !r1.reply.includes('DSH-END'));
  check('回复里不含请求头', !r1.reply.includes('[DSH#'));
  check('代码块内连续空行原样保留', /const a = 1;\n\n\nconst b = 2;/.test(r1.reply),
    JSON.stringify(r1.reply.slice(r1.reply.indexOf('const a'), r1.reply.indexOf('const a') + 40)));
  // 围栏外的连续空行必须被压缩：按 ``` 切成段，偶数段是围栏外内容（逐段检查，不要 join）
  const outside = r1.reply.split('```').filter((_, i) => i % 2 === 0);
  check('代码块外的连续空行被压成 1 个', outside.every((seg) => !/\n\n\n/.test(seg)),
    JSON.stringify(outside));

  // --- 2. 第二次请求：复用同一个标签页（握手只做一次的逻辑由 bridge-mock 覆盖）---
  step('开始第二次 ask（复用已有标签页）');
  const r2 = await bridge.ask('chat', '第二个问题');
  check('第二次也拿到了完整回复', r2.done === true && r2.reply.includes('结论：链路正常'));
  check('两次请求的 id 不同', r1.id !== r2.id, `${r1.id} vs ${r2.id}`);

  // --- 3. 提前 abort：必须抛 AbortError，不能把半截回复当结果 ---
  step('开始第三次 ask，立即 abort');
  const ac = new AbortController();
  const p3 = bridge.ask('chat', '这条会被取消', { signal: ac.signal });
  setTimeout(() => ac.abort(new Error('用户按了停止')), 400);
  let abortErr = null;
  try { await p3; } catch (e) { abortErr = e; }
  check('abort 后抛错', abortErr !== null, abortErr?.name);
  check('错误是 AbortError', abortErr?.name === 'AbortError', abortErr?.name);
  check('错误信息带上了取消原因', /用户按了停止/.test(abortErr?.message || ''), abortErr?.message);

  // --- 4. 超时：页面永不回结束标记时，必须抛错而不是返回半截 ---
  step('开始第四次 ask，超时场景（假页面故意不回复，timeoutMin=0.05 即 3 秒）');
  config.timeoutMin = 0.05;
  const r4 = await bridge.ask('chat', 'NOREPLY 这次不会有人回我').then(
    (v) => { throw new Error(`超时场景居然成功返回了：${JSON.stringify(v).slice(0, 120)}`); },
    (e) => e,
  );
  step(`超时错误：${r4.name}`);
  check('超时抛的是 HarkTimeoutError', r4.name === 'HarkTimeoutError', r4.name);
  check('超时错误说明不能当结论用', /不能当作结论使用/.test(r4.message), r4.message.slice(0, 120));

  // --- 5. 超长正文要被拒绝 ---
  config.timeoutMin = 2;
  config.maxChars = 50;
  const r5 = await bridge.ask('chat', 'x'.repeat(80)).then(
    () => { throw new Error('超长正文居然发出去了'); },
    (e) => e,
  );
  check('超长正文被拒绝', /超过上限/.test(r5.message), r5.message);
} finally {
  // 收尾：把 e2e 开的那个标签页关掉，不留垃圾在用户浏览器里
  try {
    await bridge.runScript(`
const task = await taskSpace('hark-bridge');
for (const t of await task.tabs()) {
  if (t.url && t.url.startsWith(${JSON.stringify(ORIGIN)})) {
    const p = t.label ? task.page(t.label) : await task.adopt(t.page);
    await p.close().catch(() => {});
  }
}
console.log(JSON.stringify({ ok: true }));
`, { exePath: config.browserPath });
  } catch { /* 清理失败不影响结论 */ }
  pageServer.close();
  rmSync(TMP_HOME, { recursive: true, force: true });
}

step(failed === 0 ? '全部通过' : `${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
