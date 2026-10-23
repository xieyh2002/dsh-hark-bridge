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
 *
 * attachment：模拟 Hark 附带 .md 卡片并成功下载（text 是文件内容）。
 * mdCards：轮询时报的「本次请求名下的卡片数」，实现里据此决定要不要跑下载脚本。
 */
function makeFake({ reply = '## 方案\n\n1. 先做 A', onScript, attachment = null, mdCards = 0 } = {}) {
  const state = { calls: 0, scripts: [] };
  async function* streamScript(script) {
    state.calls += 1;
    state.scripts.push(script);
    // 下载脚本的标识是 saveAs（要存到哪儿）；ask 脚本里也有卡片表达式，不能拿来认。
    if (script.includes('"saveAs"')) {
      if (!attachment) throw new Error('测试没准备附件，不该跑下载脚本');
      if (attachment.error) {
        const e = new Error(attachment.error);
        e.name = 'EgoStageError';
        e.stage = 'attachment';
        throw e;
      }
      yield { ok: true, phase: 'attachment', saved: attachment.saved, name: attachment.name };
      return;
    }
    onScript?.(script, state);
    const id = idOf(script);
    yield { ok: true, phase: 'open' };
    yield { ok: true, phase: 'sent' };
    // 和真实脚本一致：只回传 footTag 之后的部分，父进程自己补回锚点。
    yield {
      ok: true, phase: 'poll', sent: true, text: `\n${reply}\n[[DSH-END#${id}]]`, mdCards, anchored: true, mdTotal: mdCards,
    };
    yield { ok: true, phase: 'poll', sent: true, same: true, mdCards, anchored: true };
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

// --- 10. 附件原文与聊天正文并列（审查意见 N4） ---
//
// 早先是整段替换：Hark 给了文件就用文件顶掉聊天正文，于是「无法生成文件」
// 这类说明、对面针对某个小问题的直接回答，全丢了。现在两份都给。
{
  const dir = path.join(workspace, '.hark', 'replies');
  const attPath = path.join(sandbox, 'hark-att.md');
  fs.writeFileSync(attPath, '# 完整审查\n\n- 阻断 1\n- 阻断 2\n', 'utf8');
  const fake = makeFake({
    reply: '审查结果见附件。另外提醒一句：改之前先跑一遍测试。',
    mdCards: 1,
    attachment: { saved: attPath, name: '仓库审查.md' },
  });
  const { ctx, tools } = makeCtx();
  apply(ctx, { harkUrl: 'https://hark.example.com/p/1', settleMs: 0, markdownMinChars: 0 }, { bridge: { streamScript: fake.streamScript } });
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  const out = await tools[0].execute({ mode: 'review', user_request: '审查', analysis: '审整个仓库' }, exec);

  assert.ok(out.includes('# 完整审查'), `返回值应带附件原文：${out.slice(0, 200)}`);
  assert.ok(out.includes('先跑一遍测试'), '聊天正文里的额外信息不能丢');
  // 拿到附件就不再另存副本（审查意见 S-d），所以路径行说的是「附件」而不是「已保存」，
  // 且要点名是哪个文件——模型得知道去哪儿读原文。
  assert.ok(out.includes('📄 Hark 附带的文件已下载（仓库审查.md）'), `应点名附件：${out}`);
  assert.ok(out.includes(attPath), '路径要给出，模型才能读');
  // 不再往 replies 里存第二份：附件本身就是这份回复。
  const after = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  assert.equal(after, before, '附件已经落盘，不该再复制一份到 replies');
}

// --- 11. 只有附件、聊天正文没新信息时，不再存第二份（审查意见 N5） ---
{
  const dir = path.join(workspace, '.hark', 'replies');
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  const attPath = path.join(sandbox, 'hark-only.md');
  const body = '# 方案\n\n- 第一步\n';
  fs.writeFileSync(attPath, body, 'utf8');
  // 聊天正文就是附件内容本身：再存一份就是磁盘上两个几乎一样的 .md
  const fake = makeFake({ reply: body, mdCards: 1, attachment: { saved: attPath, name: '方案.md' } });
  const { ctx, tools } = makeCtx();
  apply(ctx, { harkUrl: 'https://hark.example.com/p/1', settleMs: 0, markdownMinChars: 0 }, { bridge: { streamScript: fake.streamScript } });
  const out = await tools[0].execute({ mode: 'plan', user_request: '方案', analysis: '实现' }, exec);

  const after = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  assert.equal(after, before, '附件已经落盘，不该再复制一份到 replies');
  assert.ok(out.includes(attPath), '路径要给出，模型才能读');
  assert.equal(
    (out.match(/已保存|已下载/g) || []).length,
    1,
    `同一份内容只说一次，别一个「已保存」一个「已下载」：${out}`,
  );
}

// --- 11b. saveReplies=false 时，Hark 附带的文件照样要下载 ---
//
// 早先 `attachmentSaveDir` 是在 `if (cfg.saveReplies)` 里算的，关掉落盘就变成空串，
// #withAttachment 第一行直接 return——附件根本不会去取。可「存不存聊天正文」和
// 「取不取 Hark 给的文件」是两件事：关掉落盘的人往往正是只想要文件的那种。
{
  const dir = path.join(workspace, '.hark', 'replies');
  const attPath = path.join(sandbox, 'hark-nosave.md');
  fs.writeFileSync(attPath, '# 审查意见\n\n- 只想要文件，不想要聊天记录\n', 'utf8');
  const fake = makeFake({
    reply: '审查见附件。',
    mdCards: 1,
    attachment: { saved: attPath, name: '审查.md' },
  });
  const { ctx, tools } = makeCtx();
  apply(
    ctx,
    { harkUrl: 'https://hark.example.com/p/1', saveReplies: false, settleMs: 0, markdownMinChars: 0 },
    { bridge: { streamScript: fake.streamScript } },
  );
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  const out = await tools[0].execute({ mode: 'review', user_request: '审查', analysis: '审仓库' }, exec);

  assert.ok(out.includes('📄 Hark 附带的文件已下载（审查.md）'), `关掉落盘也要下载附件：${out}`);
  assert.ok(out.includes(attPath), '要给出附件路径');
  assert.ok(out.includes('只想要文件'), '附件内容要带回来');
  const after = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  assert.equal(after, before, 'saveReplies=false 时不该另存聊天正文');
}

// --- 11c. saveReplies=false 时，没有附件就不落盘（回归） ---
{
  const dir = path.join(workspace, '.hark', 'replies');
  const fake = makeFake({ reply: '# 长正文\n\n' + '- 一条很长很长的说明\n'.repeat(80), mdCards: 0 });
  const { ctx, tools } = makeCtx();
  apply(
    ctx,
    { harkUrl: 'https://hark.example.com/p/1', saveReplies: false, settleMs: 0, markdownMinChars: 0 },
    { bridge: { streamScript: fake.streamScript } },
  );
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  const out = await tools[0].execute({ mode: 'plan', user_request: 'x', analysis: 'y' }, exec);
  const after = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  assert.equal(after, before, 'saveReplies=false 且无附件：一个字都不该写');
  assert.ok(out.includes('一条很长很长的说明'), '正文要原样给模型');
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
  // parameters 现在是标准 JSON Schema，字段定义在 properties 下。
  const spec = tools[0].parameters.properties.attachments;
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
