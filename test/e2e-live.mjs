/**
 * 真实链路 e2e：真的通过 ego 打开页面、真的打字回车、真的从页面文本里抓回复。
 *
 * 假 Hark 页面由本脚本自己起 HTTP 服务提供，不碰真实 Hark、不需要外网。
 * 用的是用户正在运行的 ego（ego-browser nodejs 通道），所以会在他浏览器里
 * 临时开一个标签页；跑完关掉。
 *
 * 假页面刻意照抄真实 Hark 的几个"怪"地方，否则测不到真正的坑：
 *  - file input 是隐藏的（width/height 为 0），只能用 setInputFiles 喂；
 *  - 选中文件后要等 800ms chip 才出现，期间 composer 带 aria-busy=true ——
 *    bridge 必须等它消失才敢发送，否则发出去的是"还没传完"的那一份；
 *  - send-button 的 aria-label 在「开始听写」/「发送消息」之间切换，
 *    空输入时按下去只是开语音，消息根本不会发出去；
 *  - md 附件卡片是懒渲染的，不滚到底就不在 DOM 里。
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// 隔离 store：握手记录不能写进用户真实的 %LOCALAPPDATA%\dsh-hark-bridge\settings.json
const TMP_HOME = mkdtempSync(join(tmpdir(), 'dsh-hark-e2e-'));
process.env.DSH_HARK_BRIDGE_HOME = TMP_HOME;

const { HarkBridge } = await import('../lib/bridge.js');
const { findEgoBrowser } = await import('../lib/ego.js');

// 默认 18941 是约定端口；允许覆盖只是为了在 CI 或多开时避开端口占用，
// 而不是换个地方偷偷跑——换个端口跑出来的结论和默认端口完全一样。
const PORT = Number(process.env.DSH_HARK_E2E_PORT) || 18941;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** 假页面给下载路由返回的固定 markdown：换行/围栏/引用都要能原样落盘 */
const MD = [
  '# 方案',
  '',
  '- 第一步：改 bridge.js',
  '- 第二步：补测试',
  '',
  '> 这条引用必须保真',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
].join('\n');

const PAGE = [
  '<!doctype html><meta charset="utf-8"><title>Fake Hark</title>',
  '<style>body{font:14px/1.5 system-ui;margin:20px}textarea{width:600px;height:80px}',
  '#chips span{display:inline-block;padding:2px 8px;margin:2px;background:#eee;border-radius:10px}',
  '#log{white-space:pre-wrap;margin-top:16px;border-top:1px solid #ccc;padding-top:12px}</style>',
  '<div id="composer">',
  '  <div id="chips"></div>',
  '  <textarea id="in" data-testid="chat-input" aria-label="消息输入" placeholder="给 Hark 发消息"></textarea>',
  // 隐藏而不是 display:none：真实 Hark 的 input 是零尺寸但仍在布局里，
  // setInputFiles 的可用性取决于这个细节，用 display:none 测出来的绿是假的。
  '  <input id="file" type="file" multiple style="position:absolute;width:0;height:0;opacity:0">',
  '  <button id="send" data-testid="send-button" aria-label="开始听写">发送</button>',
  '</div>',
  '<div id="log"></div>',
  '<script>',
  'const ta = document.getElementById("in");',
  'const log = document.getElementById("log");',
  'const sendBtn = document.getElementById("send");',
  'const composer = document.getElementById("composer");',
  'const chips = document.getElementById("chips");',
  'const fileInput = document.getElementById("file");',
  'let seq = 0;',
  'const chipNames = () => [...chips.children].map((s) => s.textContent);',
  // 空输入时是「开始听写」，有内容/附件才是「发送消息」——bridge 靠这个判断能不能发
  'function syncSend() {',
  '  const busy = composer.getAttribute("aria-busy") === "true";',
  '  const has = !!ta.value.trim() || chipNames().length > 0;',
  '  sendBtn.disabled = !has || busy;',
  '  sendBtn.setAttribute("aria-label", has && !busy ? "发送消息" : "开始听写");',
  '}',
  'fileInput.addEventListener("change", () => {',
  '  const names = [...fileInput.files].map((f) => f.name);',
  '  composer.setAttribute("aria-busy", "true");',
  '  syncSend();',
  '  setTimeout(() => {',
  '    chips.textContent = "";',
  '    for (const n of names) { const s = document.createElement("span"); s.textContent = n; chips.appendChild(s); }',
  '    composer.removeAttribute("aria-busy");',
  '    syncSend();',
  '  }, 800);',
  '});',
  // md 卡片：点开才插 dialog，卡片本身不带 href —— 跟真实 Hark 一样要两步
  'function mdCard() {',
  '  const card = document.createElement("button");',
  // 用中文名，是因为真实 Hark 的附件名常常是中文（"仓库审查意见.md"）。bridge 要从
  // aria-label 里剥掉「打开 … 的预览」前后缀才能拿到文件名，这条断言同时验证那段正则
  // 对中文生效（审查意见建议 3）——早先正则被二次转义吃掉时，中文名会整个解析失败。
  '  card.setAttribute("aria-label", "打开 仓库审查意见.md 的预览");',
  // 不放可见文字：卡片现在挂在气泡里面（见下面 appendChild 的注释），而 bridge 用
  // 气泡 innerText 判定结束标记和发言归属，卡片文字会粘在标记后面把「标记在行尾」破坏掉。
  // 真实 Hark 用图标 + aria-label，可见文件名在卡片内部更深的节点里，不影响这里的判断。
  '  card.textContent = "";',
  '  card.addEventListener("click", () => {',
  '    for (const old of document.querySelectorAll("[role=dialog]")) old.remove();',
  '    const dlg = document.createElement("div");',
  '    dlg.setAttribute("role", "dialog");',
  '    const a = document.createElement("a");',
  '    a.setAttribute("download", "");',
  '    a.setAttribute("href", "/api/files/x/artifact?key=reply.md");',
  '    a.textContent = "下载";',
  '    dlg.appendChild(a);',
  '    document.body.appendChild(dlg);',
  '  });',
  '  return card;',
  '}',
  'function send() {',
  '  const text = ta.value;',
  '  if (!text.trim()) return;',
  '  seq += 1;',
  '  const names = chipNames();',
  '  const box = document.createElement("div");',
  '  box.setAttribute("data-message-id", "m" + seq);',
  '  const bubble = document.createElement("div");',
  '  bubble.setAttribute("data-testid", "message-bubble");',
  '  bubble.setAttribute("data-bubble-id", "b" + seq);',
  // 文件名写进气泡：bridge 的「发送后校验」就是在这里找的
  '  bubble.textContent = text + (names.length ? "\\n[附件] " + names.join("、") : "");',
  '  box.appendChild(bubble);',
  '  log.appendChild(box);',
  '  ta.value = "";',
  '  chips.textContent = "";',
  '  syncSend();',
  '  const m = /\\[DSH#([a-z0-9]+)\\]/.exec(text);',
  '  const id = m ? m[1] : "unknown";',
  '  if (text.includes("NOREPLY")) { window.__trace = "deliberately silent"; return; }',
  '  setTimeout(() => {',
  '    const r = document.createElement("div");',
  '    r.setAttribute("data-message-id", "r" + seq);',
  '    const rb = document.createElement("div");',
  '    rb.setAttribute("data-testid", "message-bubble");',
  '    rb.setAttribute("data-bubble-id", "rb" + seq);',
  '    rb.textContent = [',
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
  '    r.appendChild(rb);',
  // 卡片必须挂在气泡里面：bridge 是按「包含 footTag 的气泡之后的那个气泡里」来找卡片的，
  // 挂在气泡外面的兄弟节点上，closest() 会返回 null，永远找不到——真实 Hark 也是挂在气泡里。
  '    rb.appendChild(mdCard());',
  '    log.appendChild(r);',
  '  }, 500);',
  '}',
  'ta.addEventListener("keydown", (e) => {',
  '  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }',
  '});',
  'ta.addEventListener("input", syncSend);',
  'sendBtn.addEventListener("click", send);',
  'syncSend();',
  '</script>',
].join('\n');

const pageServer = createServer((req, res) => {
  // 下载走独立路由：bridge 用 page.fetch 直接抓字节，靠的就是这个 URL 能返回文件本身
  if ((req.url || '').startsWith('/api/files/')) {
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    res.end(MD);
    return;
  }
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
  // e2e 的假回复都很短，这里把「多长才走文件」的门槛关掉：本文件要验的是通道本身
  // 能不能跑通，门控逻辑由 bridge-mock 的 13/13b 两个用例单独覆盖。
  markdownMinChars: 0,
  fetchAttachment: true,
  attachTimeoutSec: 60,
  fileInputSelector: '',
  attachmentSelector: '',
};
const getConfig = () => config;

const t0 = Date.now();
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// 造一条 attachments 记录：形状跟 lib/attach.js 的产出一致，staged 必须真的落盘
// （上传要读它，降级内联也要读它）。
let upSeq = 0;
function makeAttachment(name, content) {
  upSeq += 1;
  const staged = join(TMP_HOME, 'attach', `u${upSeq}__${name}`);
  mkdirSync(dirname(staged), { recursive: true });
  writeFileSync(staged, content, 'utf8');
  return {
    rel: `src/${name}`,
    abs: join(TMP_HOME, 'src', name),
    staged,
    uploadName: name,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: `e2e${upSeq}`,
  };
}

await new Promise((r) => pageServer.listen(PORT, '127.0.0.1', r));
step(`假 Hark 页面已就绪 ${ORIGIN}`);

if (!config.browserPath) {
  console.log('SKIP  没有找到 ego-browser，跳过真实链路测试');
  pageServer.close();
  process.exit(0);
}
step(`使用 ego-browser: ${config.browserPath}`);

// 排查用：DSH_HARK_E2E_TRACE=1 时把脚本事件逐条打出来。
// 真 ego 上一次失败往往只有"超时"这一个信号，看不到它卡在 open/sent/poll 哪一步，
// 开关留给下次调 DOM 变化时用，比事后加日志快。
const TRACE = process.env.DSH_HARK_E2E_TRACE === '1';
const bridge = TRACE
  ? new HarkBridge(getConfig, {
    streamScript: async function* (script, opts) {
      step(`脚本 ${script.length} 字符`);
      const { streamEgoScript } = await import('../lib/ego.js');
      for await (const ev of streamEgoScript(script, opts)) {
        step(`  event ${JSON.stringify(ev).slice(0, 300)}`);
        yield ev;
      }
    },
  })
  : new HarkBridge(getConfig);
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

  // --- 6. 双向文件：上行把两个文件挂进隐藏的 file input，下行把回复里的 md 抓下来 ---
  config.maxChars = 60000;
  const savePath = join(TMP_HOME, 'reply.md');
  // 一个文件名带空格、一个带中文和空格：Hark 侧显示的是这个 uploadName，
  // 中文/空格在 chip 文本、气泡校验、setInputFiles 三处都要能原样对上。
  const up1 = makeAttachment('a b.js', 'const a = 1;\n');
  const up2 = makeAttachment('中文 名.md', '# 标题\n\n内容\n');
  step('开始第六次 ask（带两个附件，并下载回复附件）');
  const r6 = await bridge.ask('plan', '看下这两个附件', {
    attachments: [up1, up2],
    attachmentSavePath: savePath,
  });
  step(`附件往返结束，attachMode=${r6.attachMode}，warnings=${JSON.stringify(r6.warnings)}`);
  check('上行：attachMode 是 upload', r6.attachMode === 'upload', String(r6.attachMode));
  check('上行：两个文件都挂上了', Array.isArray(r6.attached) && r6.attached.length === 2,
    JSON.stringify(r6.attached));
  check('下行：attachmentReply 等于假页面返回的 markdown', r6.attachmentReply === MD,
    JSON.stringify(String(r6.attachmentReply || '').slice(0, 60)));
  // 中文附件名要原样解析出来，不能被清洗成下划线（审查意见建议 3）
  check('下行：中文附件名原样解析', r6.attachmentName === '仓库审查意见.md', String(r6.attachmentName));
  check('发送后校验：气泡里有文件名，没有缺失警告',
    !r6.warnings.some((w) => w.includes('发送后校验')), JSON.stringify(r6.warnings));
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
