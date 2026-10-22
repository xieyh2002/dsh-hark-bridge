/**
 * 工具层接线测试：ask_hark 把 Hark 的回复落盘，并把「文件路径 + 预览」交给模型。
 *
 * 为什么不连真浏览器：这里要验的是「拿到了回复之后怎么处理」——落不落盘、
 * 落哪、返回值长什么样。用注入的假 ego 通道跑完整链路，比真开 ego 快两个数量级，
 * 而且能稳定造出超长回复、附件、越界目录这些真实场景里难复现的情况。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-tool-'));
process.env.DSH_HARK_BRIDGE_HOME = sandbox;

const { apply, formatAskResult, resolveWorkspaceRoot, composeBody } = await import('../lib/index.js');

/** 从生成的脚本里抠出这次请求的编号（脚本里 foot 形如 [/DSH#abc123]） */
function idOf(script) {
  const m = /"foot":"\[\/DSH#([^\]"]+)\]"/.exec(script);
  assert.ok(m, '脚本里应该带 footTag');
  return m[1];
}

/**
 * 假 ego 通道。
 *
 * 第二个脚本调用（也就是握手之后的那次真实请求）返回 reply，之前的一律当作握手
 * 直接给一个 done，避免测试卡在握手预算上。
 */
function makeFake({ reply = '## 方案\n\n1. 先做 A', onScript } = {}) {
  const state = { calls: 0, scripts: [] };
  async function* streamScript(script) {
    state.calls += 1;
    state.scripts.push(script);
    onScript?.(script, state);
    const id = idOf(script);
    yield { ok: true, phase: 'open' };
    yield { ok: true, phase: 'sent' };
    // 和真实脚本一致：只回传 footTag 之后的部分，父进程自己补回锚点。
    yield { ok: true, phase: 'poll', sent: true, text: `\n${reply}\n[[DSH-END#${id}]]` };
    yield { ok: true, phase: 'poll', sent: true, same: true };
  }
  return { state, streamScript };
}

function makeCtx() {
  const tools = [];
  const commands = [];
  const ctx = {
    effect: (fn) => fn(),
    get: (n) => (n === 'commands' ? { register: (c) => { commands.push(c); return () => {}; } } : undefined),
    tools: { register: (t) => { tools.push(t); return () => {}; } },
  };
  return { ctx, tools, commands };
}

// 工作区：临时目录本身就当工作区，落盘会进 <ws>/.hark/replies
const workspace = path.join(sandbox, 'ws');
fs.mkdirSync(workspace, { recursive: true });
const exec = { agent: { session: { header: { cwd: workspace } } } };

// --- 1. 正常路径：回复落盘，返回值给路径 + 预览 ---
{
  const fake = makeFake({ reply: '## 方案\n\n先改 lib/protocol.js，再补测试。' });
  const { ctx, tools } = makeCtx();
  apply(ctx, { harkUrl: 'https://hark.example.com/p/1', settleMs: 0, markdownMinChars: 0 }, { bridge: { streamScript: fake.streamScript } });

  const out = await tools[0].execute(
    { mode: 'plan', user_request: '加导出', analysis: '目标：导出 CSV' },
    exec,
  );
  assert.ok(out.includes('📄 完整回复已保存'), `返回值应包含保存路径：${out}`);
  assert.ok(out.includes('先改 lib/protocol.js'), '返回值应带正文预览');
  assert.ok(out.includes('模式 plan'), '返回值应标明模式');

  const dir = path.join(workspace, '.hark', 'replies');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, `应恰好落一个文件，实际：${files}`);
  const abs = path.join(dir, files[0]);
  assert.ok(files[0].endsWith('.md'), '应为 .md 文件');
  const text = fs.readFileSync(abs, 'utf8');
  assert.ok(text.includes('先改 lib/protocol.js'), '文件里应是完整回复');
  assert.ok(/^---\n/.test(text), '应带 YAML front matter');
  assert.ok(text.includes('mode: plan'), 'front matter 应记下模式');
  // 返回值里的相对路径要能在工作区里定位到
  assert.ok(out.includes(files[0]), '返回值应包含文件名');
}

// --- 2. 超长回复：文件里是全文，返回值只给预览 ---
{
  const long = 'x'.repeat(3000);
  const fake = makeFake({ reply: long });
  const { ctx, tools } = makeCtx();
  apply(ctx, { harkUrl: 'https://hark.example.com/p/1', settleMs: 0, markdownMinChars: 0 }, { bridge: { streamScript: fake.streamScript } });

  const out = await tools[0].execute({ mode: 'review', user_request: '审一下', analysis: '看 diff' }, exec);
  assert.ok(out.includes('已截断'), '超长回复应截断预览');
  assert.ok(out.length < 3000, `返回值不该超过原文，实际 ${out.length}`);
  const dir = path.join(workspace, '.hark', 'replies');
  const reviewFiles = fs.readdirSync(dir).filter((f) => f.includes('review'));
  assert.ok(reviewFiles.length >= 1, '应在文件里保留全文');
  const body = fs.readFileSync(path.join(dir, reviewFiles[0]), 'utf8');
  assert.ok(body.includes(long), '落盘文件应是完整 3000 字符');
}

// --- 3. saveReplies=false：不落盘，退回返回全文 ---
{
  const fake = makeFake({ reply: '简短结论' });
  const { ctx, tools } = makeCtx();
  apply(ctx, { harkUrl: 'https://hark.example.com/p/1', saveReplies: false, settleMs: 0 }, { bridge: { streamScript: fake.streamScript } });
  const before = fs.existsSync(path.join(workspace, '.hark', 'replies'))
    ? fs.readdirSync(path.join(workspace, '.hark', 'replies')).length
    : 0;

  const out = await tools[0].execute({ mode: 'chat', user_request: 'x', analysis: 'y' }, exec);
  assert.ok(!out.includes('📄 完整回复已保存'), '关掉落盘后不该给保存路径');
  assert.ok(out.includes('简短结论'), '关掉落盘后应直接给全文');
  const after = fs.existsSync(path.join(workspace, '.hark', 'replies'))
    ? fs.readdirSync(path.join(workspace, '.hark', 'replies')).length
    : 0;
  assert.equal(after, before, '关掉落盘后不该新增文件');
}

// --- 4. replyDir 越界：降级成不落盘 + 警告，不阻断对话 ---
{
  const fake = makeFake({ reply: '照常回复' });
  const { ctx, tools } = makeCtx();
  apply(ctx, { harkUrl: 'https://hark.example.com/p/1', replyDir: '../../../etc', settleMs: 0, markdownMinChars: 0 }, { bridge: { streamScript: fake.streamScript } });
  const out = await tools[0].execute({ mode: 'chat', user_request: 'x', analysis: 'y' }, exec);
  assert.ok(out.includes('照常回复'), '目录配错也要拿到回复');
  assert.ok(out.includes('⚠️') && out.includes('回复文件没能保存'), '应说明没存成');
}

// --- 5. /hark 命令同样落盘 ---
{
  const fake = makeFake({ reply: '命令回复' });
  const { ctx, commands } = makeCtx();
  apply(ctx, { harkUrl: 'https://hark.example.com/p/1', settleMs: 0, markdownMinChars: 0 }, { bridge: { streamScript: fake.streamScript } });
  const cmd = commands.find((c) => c.name === 'hark');
  const r = await cmd.handler({ rawInput: '问一下', signal: undefined });
  assert.equal(r.kind, 'success');
  assert.ok(r.text.includes('📄 完整回复已保存'), '/hark 也应落盘');
  assert.ok(r.text.includes('命令回复'));
}

// --- 6. formatAskResult 的边界：空回复、附件、警告 ---
{
  assert.ok(formatAskResult({ id: 'a1', mode: 'chat', reply: '' }).includes('模式 chat'));
  const withFile = formatAskResult(
    { id: 'a2', mode: 'plan', reply: 'r', attachmentPath: '/tmp/x.md', attached: ['a.md', 'b.md'], warnings: ['附件已跳过：太大'] },
    { replyPath: '.hark/replies/x.md' },
  );
  assert.ok(withFile.includes('📎 Hark 附带的文件已下载：/tmp/x.md'));
  assert.ok(withFile.includes('已上传附件：a.md、b.md'));
  assert.ok(withFile.includes('⚠️ 附件已跳过：太大'));
  const inlined = formatAskResult({ id: 'a3', mode: 'chat', reply: 'r', attachMode: 'inline' });
  assert.ok(inlined.includes('已改为把文件内容贴在消息正文里'));
}

// --- 6b. 短回复不落盘：一句话的回答直接用正文（默认 markdownMinChars = 1200） ---
{
  const dir = path.join(workspace, '.hark', 'replies');
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  const fake = makeFake({ reply: '收到。' });
  const { ctx, tools } = makeCtx();
  apply(ctx, { harkUrl: 'https://hark.example.com/p/1', settleMs: 0 }, { bridge: { streamScript: fake.streamScript } });
  const out = await tools[0].execute({ mode: 'chat', user_request: '在吗', analysis: '只是打个招呼' }, exec);
  assert.ok(!out.includes('完整回复已保存'), `一句「收到」不该落成文件：${out}`);
  assert.ok(out.includes('收到'), '正文仍要原样返回给模型');
  const after = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  assert.equal(after, before, '短回复不该在 .hark/replies 里多出文件');
}

// --- 7. resolveWorkspaceRoot：优先会话 cwd，取不到退回进程目录 ---
{
  assert.equal(resolveWorkspaceRoot({ agent: { session: { header: { cwd: '/tmp/proj' } } } }), '/tmp/proj');
  assert.equal(resolveWorkspaceRoot({}), process.cwd());
  assert.equal(resolveWorkspaceRoot(undefined), process.cwd());
  assert.equal(resolveWorkspaceRoot({ agent: { session: { header: { cwd: '  ' } } } }), process.cwd());
}

// --- 8. attachments 参数：工具 schema 里声明成字符串数组，且不接受工作区外的路径 ---
{
  const fake = makeFake({ reply: 'ok' });
  const { ctx, tools } = makeCtx();
  apply(ctx, { harkUrl: 'https://hark.example.com/p/1', settleMs: 0, markdownMinChars: 0 }, { bridge: { streamScript: fake.streamScript } });
  const spec = tools[0].parameters.attachments;
  assert.ok(spec, 'ask_hark 应有 attachments 参数');
  assert.equal(spec.type, 'array');
  assert.equal(spec.items.type, 'string');

  // 绝对路径越界应被 attach 层拒绝，而不是静默忽略
  await assert.rejects(
    () => tools[0].execute({ mode: 'plan', user_request: 'x', analysis: 'y', attachments: ['C:/Windows/win.ini'] }, exec),
    /附件|工作区/,
  );
}

// --- 9. 正文组装仍然遵守四段结构（回归） ---
{
  const body = composeBody({ user_request: 'u', analysis: 'a' });
  assert.ok(body.startsWith('## 用户原话\nu'));
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('tool output tests passed');
