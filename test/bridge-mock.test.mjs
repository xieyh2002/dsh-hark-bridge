/**
 * 用假的 ego 通道走一遍完整流程：选页 → 等输入框 → 输入 → 回车 → 等待结束标记
 *
 * 真的 ego 由 test/e2e-live.mjs 覆盖；这里只验证 bridge 的协议逻辑
 * （消息拼装、结束标记识别、握手、排队），不依赖任何浏览器。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// 必须在 import store 之前设好：store 在模块顶层就会读一次 dataDir()。
// 不隔离的话，握手记录会写进用户真实的 %LOCALAPPDATA%\dsh-hark-bridge\settings.json。
const TMP_HOME = mkdtempSync(join(tmpdir(), 'dsh-hark-test-'));
process.env.DSH_HARK_BRIDGE_HOME = TMP_HOME;

const { HarkBridge } = await import('../lib/bridge.js');
const { DEFAULT_CONFIG } = await import('../lib/config-schema.js');
const { endTag, footTag, buildRulesBody } = await import('../lib/protocol.js');
const { readOverride } = await import('../lib/store.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从生成的脚本里把 message 抠出来，等价于"真的往输入框里打了这些字" */
function messageOf(script) {
  const m = /"message":("(?:[^"\\]|\\.)*")/.exec(script);
  return m ? JSON.parse(m[1]) : '';
}

/** 从脚本里抠出 setInputFiles 的路径数组，等价于"真的往文件输入框里塞了这些文件" */
function stagedOf(script) {
  const m = /"staged":(\[[^\]]*\])/.exec(script);
  return m ? JSON.parse(m[1]) : [];
}

/**
 * 造一个真的工作区文件，返回工作区相对路径。
 *
 * 为什么不手写假的 attachments 对象：bridge 现在会把路径交给 lib/attach.js 做
 * 越界/敏感文件/超限校验再暂存，手写对象等于绕过被测代码，测试看着是绿的
 * 但真实链路（暂存名扁平化、sha256 复核、中文名处理）一次都没跑到。
 */
function writeWorkspaceFile(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return rel;
}

/**
 * 假 ego：按真实脚本的约定回传尾部文本。
 *
 * 真实脚本只 emit `{phase:'poll', sent:true, text: <footTag 之后的页面文本>}`
 * （审查意见 B3：整页 innerText 随对话增长会变成 O(n²) 回传）。
 * 页面被渲染成「能看到请求、还没有回复」时 tail 就是请求之后那点空白。
 *
 * 附件相关的能力（attach/missing/下载）都靠脚本正文特征判定：
 * 生成器拿不到"页面状态"，只能从脚本内容反推这次跑的是哪条分支。
 */
function makeFakeEgo({
  replyAfterPolls = 2,
  reply = '方案：\n1. 加 /export 命令',
  neverReplies = false,
  attach = 'ready',
  missing = [],
  download = null,
} = {}) {
  const state = { typed: '', calls: 0, all: [], scripts: [], staged: [] };
  const streamScript = async function* (script, { signal } = {}) {
    state.calls += 1;
    state.scripts.push(script);
    // 下载脚本是第二个独立脚本（没有请求 id），先单独处理掉
    if (script.includes('data-dsh-md')) {
      if (!download) throw new Error('测试没给 download 行为，不该跑下载脚本');
      const ev = await download();
      if (ev?.error) {
        const e = new Error(ev.error);
        e.name = 'EgoStageError';
        e.stage = 'attachment';
        throw e;
      }
      yield { ok: true, phase: 'attachment', ...ev };
      return;
    }
    state.typed = messageOf(script);
    state.all.push(state.typed);
    state.staged.push(stagedOf(script));
    const id = (state.typed.match(/\[DSH#([a-z0-9]+)\]/) || [])[1];
    assert.ok(id, '发出去的消息里要带请求 id');
    const foot = footTag(id);
    yield { ok: true, phase: 'open' };
    // 脚本模板里永远有 setInputFiles 这行代码，判断「带不带附件」只能看 staged 是否为空
    const staged = stagedOf(script);
    if (staged.length) {
      if (attach === 'fail') {
        const e = new Error('60 秒内附件没有就绪（chip 未出现或发送按钮未启用）');
        e.name = 'EgoStageError';
        e.stage = 'attach';
        throw e;
      }
      yield { ok: true, phase: 'attach', ready: true };
    }
    yield { ok: true, phase: 'sent' };
    if (missing.length) yield { ok: true, phase: 'attach-missing', names: missing };
    for (let i = 0; i < 20; i++) {
      if (signal?.aborted) {
        const e = new Error('已取消');
        e.name = 'AbortError';
        throw e;
      }
      // 完整页面长这样（导航栏在前，然后是我们的请求，之后是 Hark 的回复）
      const page = `导航栏\n${state.typed}\n${!neverReplies && i >= replyAfterPolls ? `${reply}\n${endTag(id)}` : ''}`;
      const at = page.indexOf(foot);
      yield at < 0
        ? { ok: true, phase: 'poll', sent: false }
        : { ok: true, phase: 'poll', sent: true, text: page.slice(at + foot.length) };
      await sleep(20);
    }
  };
  const runScript = async () => ({ ok: true, url: 'https://hark.example/p/1' });
  return { state, streamScript, runScript };
}

const URL1 = 'https://hark.example/p/1';
const baseCfg = { ...DEFAULT_CONFIG, harkUrl: URL1, pollMs: 10, settleMs: 10 };

// 1. 正常往返：首轮先握手，再发正式请求
{
  const ego = makeFakeEgo();
  const bridge = new HarkBridge(() => baseCfg, ego);
  const r = await bridge.ask('plan', '给插件加导出功能');
  assert.equal(r.done, true);
  assert.equal(r.reply, '方案：\n1. 加 /export 命令');

  assert.equal(ego.state.calls, 2, '首次 ask 应该是「握手 + 正式请求」两次');
  assert.ok(ego.state.all[0].includes('你的回复要求'), '第一次发的是规则说明');
  assert.ok(ego.state.all[0].includes('DSH-END'), '规则里要说清结束标记长什么样');
  assert.ok(ego.state.all[1].includes('给插件加导出功能'), '第二次才是真正的正文');
  assert.ok(ego.state.all[1].includes('[DSH#'), '消息要带请求 id');
  assert.ok(!ego.state.all[1].includes(endTag('')), '消息里不能出现结束标记的空壳');
  assert.equal(readOverride().handshakes?.[URL1], 1, '握手完成后要记下来');
}

// 2. 握手只做一次：同一地址第二次 ask 不再重发规则
{
  const ego = makeFakeEgo();
  const cfg2 = { ...baseCfg, harkUrl: 'https://hark.example/p/2' };
  const bridge = new HarkBridge(() => cfg2, ego);
  const a = await bridge.ask('plan', '第一个');   // 握手 + 正式 = 2 次
  assert.equal(ego.state.calls, 2, '第一次应该是「握手 + 正式请求」');
  const b = await bridge.ask('chat', '第二个');  // 只有正式 = 1 次
  assert.notEqual(a.id, b.id, '两次请求的 id 必须不同');
  assert.equal(ego.state.calls, 3, '握手 1 次 + 正式请求 2 次');
  assert.ok(!ego.state.all[2].includes('你的回复要求'), '第二次 ask 不该再发规则');
  assert.ok(ego.state.all[2].includes('第二个'), '第二次 ask 发的就是正文');
}

// 3. 换了 Hark 地址要重新握手
{
  const ego = makeFakeEgo();
  const url3 = 'https://hark.example/p/3';
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: url3 }), ego);
  await bridge.ask('chat', '换个页面');
  assert.equal(ego.state.calls, 2, '新地址要重新握手');
  assert.equal(readOverride().handshakes?.[url3], 1);
}

// 4. 没有设置 harkUrl 时给出可操作的提示，而不是空指针
{
  const ego = makeFakeEgo();
  const bridge = new HarkBridge(() => ({ ...DEFAULT_CONFIG }), ego);
  await assert.rejects(() => bridge.ask('plan', 'x'), (e) => {
    assert.match(e.message, /还没有设置 Hark 地址/);
    assert.match(e.message, /\/hark-url/);
    return true;
  });
  assert.equal(ego.state.calls, 0, '没有地址时不该启动任何请求');
}

// 5. 超长正文在打字之前就被拒
{
  const ego = makeFakeEgo();
  const bridge = new HarkBridge(() => ({ ...baseCfg, maxChars: 50 }), ego);
  await assert.rejects(() => bridge.ask('plan', 'x'.repeat(80)), (e) => {
    assert.match(e.message, /超过上限 50/);
    return true;
  });
  assert.equal(ego.state.calls, 0, '被拒的请求不该启动浏览器');
}

// 6. 握手失败不能挡住正式请求（Hark 可能早就学会规则了）
{
  let call = 0;
  const ego = makeFakeEgo();
  const flaky = {
    ...ego,
    streamScript: async function* (script, opts) {
      call += 1;
      if (call === 1) {
        const e = new Error('ego 调用意外结束（exit 1）');
        e.name = 'EgoStageError';
        throw e;
      }
      yield* ego.streamScript(script, opts);
    },
  };
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/9' }), flaky);
  const r = await bridge.ask('chat', '握手挂了也要能发');
  assert.equal(r.done, true);
  assert.ok(r.reply.includes('方案'));
}

// 7. 规则文本自身不能撞上结束标记（否则会被自己判成"已回复"）
{
  const body = buildRulesBody();
  const id = 'abc123';
  const full = `[DSH#${id}] chat\n${body}\n${footTag(id)}`;
  assert.ok(!full.includes(endTag(id)), '拼好的消息里不能出现真实结束标记');
  // 规则正文里不能出现「像真 id」的请求头，否则 Hark 会照抄出第二个请求头
  assert.ok(!body.includes(`[DSH#${id}]`), '规则正文里不能出现真实 id 的请求头');
  // 整条消息里 id 只应出现在请求头和结尾标记两处（正文里一次都不能有）
  const hits = full.split(`[DSH#${id}]`).length - 1;
  assert.equal(hits, 1, `id 只该出现在请求头一处，实际 ${hits} 处`);
  assert.ok(body.includes('<编号>'), '规则里要用占位符代替真实编号');
}

// 8. 带 attachmentPaths：脚本里要真把 staged 路径塞给文件输入框，返回值声称已上传
{
  const ego = makeFakeEgo();
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/8' }), ego);
  const ws = mkdtempSync(join(TMP_HOME, 'ws-'));
  const p1 = writeWorkspaceFile(ws, 'lib/bridge.js', 'const x = 1;\n');
  // 中文名 + 空格名：这两个是最容易在扁平化/暂存那一步被改坏的名字
  const p2 = writeWorkspaceFile(ws, 'docs/测试 文件.md', '# 标题\n');
  const r = await bridge.ask('plan', '看下这两个文件', {
    attachmentPaths: [p1, p2],
    workspaceRoot: ws,
    attachmentSavePath: '',
  });
  const script = ego.state.scripts[ego.state.scripts.length - 1];
  assert.ok(script.includes('page.setInputFiles'), '带附件时脚本里必须有 setInputFiles');
  const staged = ego.state.staged.at(-1);
  assert.equal(staged.length, 2, `setInputFiles 要拿到 2 个路径，实际 ${JSON.stringify(staged)}`);
  const attachRoot = join(ws, '.hark', 'attach');
  for (const p of staged) {
    assert.ok(script.includes(JSON.stringify(p)), `脚本里要出现暂存路径 ${p}`);
    // 必须是暂存副本（staged），不能是原文件（abs）：同名文件靠暂存目录唯一化
    assert.ok(p.startsWith(attachRoot), `暂存路径要落在 ${attachRoot} 下，实际 ${p}`);
  }
  assert.equal(r.attachMode, 'upload');
  assert.deepEqual(r.attached, ['lib__bridge.js', 'docs__测试 文件.md'], 'attached 是 uploadName 数组');
  // staged 必须是暂存副本的路径，不能是原文件——重名文件靠暂存目录唯一化
  for (const p of staged) assert.ok(!p.startsWith(join(ws, 'lib')) && !p.startsWith(join(ws, 'docs')));
  assert.equal(r.done, true);
  assert.equal(r.reply, '方案：\n1. 加 /export 命令');
  assert.deepEqual(r.warnings, []);
  assert.ok(!('attachmentReply' in r), '没下载时不能带 attachmentReply 这个键');
  // 请求结束要把暂存目录清掉，不然 .hark/attach 会一直堆着文件副本
  assert.equal(existsSync(join(ws, '.hark', 'attach', r.id)), false, '暂存目录要在 ask 结束后清掉');
}

// 9. attach 阶段超时 + 总量放得下 → 降级成正文内联，reply 照常返回
{
  const ego = makeFakeEgo({ attach: 'fail' });
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/9' }), ego);
  const ws = mkdtempSync(join(TMP_HOME, 'ws-'));
  writeWorkspaceFile(ws, 'inline-me.js', 'export const answer = 42;\n');
  const r = await bridge.ask('plan', '看看这个文件', {
    attachmentPaths: ['inline-me.js'], workspaceRoot: ws,
  });
  assert.equal(r.done, true);
  assert.equal(r.attachMode, 'inline');
  assert.deepEqual(r.attached, [], '降级后没有任何文件真的上传');
  assert.equal(r.reply, '方案：\n1. 加 /export 命令');
  assert.ok(r.warnings.some((w) => w.includes('降级')), `warnings 里要有降级说明：${JSON.stringify(r.warnings)}`);
  const last = ego.state.all.at(-1);
  assert.ok(last.includes('## 附件 inline-me.js'), '内联正文里要有附件小节');
  assert.ok(last.includes('export const answer = 42;'), '内联正文里要有文件内容');
  assert.equal(ego.state.staged.at(-1).length, 0, '降级那次不能再带附件');
}

// 10. attach 阶段超时 + 附件太大 → HarkAttachError，不能偷偷内联
{
  const ego = makeFakeEgo({ attach: 'fail' });
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/10', maxChars: 1000 }), ego);
  const ws = mkdtempSync(join(TMP_HOME, 'ws-'));
  // 2000 字节 > maxChars(1000)：降级放不下，必须报错而不是悄悄丢掉附件
  writeWorkspaceFile(ws, 'big.txt', 'x'.repeat(2000));
  await assert.rejects(() => bridge.ask('plan', '大文件', {
    attachmentPaths: ['big.txt'], workspaceRoot: ws,
  }), (e) => {
    assert.equal(e.name, 'HarkAttachError');
    assert.match(e.message, /附件上传超时，且内容过大无法内联/);
    return true;
  });
}

// 11. fetchAttachment:false / 没有 attachmentSavePath 时，绝不跑第二个下载脚本
{
  for (const [label, cfgPatch, opts] of [
    ['fetchAttachment:false', { fetchAttachment: false }, { attachmentSavePath: join(TMP_HOME, 'x.md') }],
    ['没有 attachmentSavePath', {}, {}],
  ]) {
    const ego = makeFakeEgo();
    const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: `https://hark.example/p/11-${label}`, ...cfgPatch }), ego);
    const r = await bridge.ask('plan', '这次不该下载', opts);
    assert.equal(r.done, true);
    // 握手 1 次 + 正式请求 1 次；多出来的就说明下载脚本被跑了
    assert.equal(ego.state.calls, 2, `${label}：脚本调用次数应该是 2，实际 ${ego.state.calls}`);
    assert.ok(!('attachmentReply' in r));
  }
}

// 12. attach-missing 事件 → warnings 里点名，但结果仍然算成功
{
  const ego = makeFakeEgo({ missing: ['lib__bridge.js'] });
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/12' }), ego);
  const ws = mkdtempSync(join(TMP_HOME, 'ws-'));
  writeWorkspaceFile(ws, 'lib/bridge.js', 'x');
  const r = await bridge.ask('plan', '带附件', { attachmentPaths: ['lib/bridge.js'], workspaceRoot: ws });
  assert.equal(r.done, true);
  assert.ok(r.warnings.some((w) => w.includes('lib__bridge.js')), JSON.stringify(r.warnings));
}

// 13. 下载成功 → attachmentReply 是文件里的文本
{
  // 必须够长且像文档：短回复现在直接读正文，不会去下载（见 13b）。
  const md = `# 方案\n\n- 第一步\n- 第二步\n\n> 引用\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n${'- 补充说明，用来把回复撑到文件通道的门槛以上。\n'.repeat(60)}`;
  const savePath = join(TMP_HOME, 'reply.md');
  const ego = makeFakeEgo({
    reply: md,
    download: async () => { writeFileSync(savePath, md, 'utf8'); return { saved: savePath, name: 'reply.md' }; },
  });
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/13' }), ego);
  const r = await bridge.ask('plan', '给我一个 md', { attachmentSavePath: savePath });
  assert.equal(r.done, true);
  assert.equal(r.attachmentReply, md, 'attachmentReply 要等于下载到的文件内容');
  assert.equal(r.attachmentName, 'reply.md');
  assert.deepEqual(r.warnings, []);
}

// 13b. 一句话的回复不下载文件：页面上没有本次卡片时去翻，只会翻到别人的旧卡片
{
  const ego = makeFakeEgo({ reply: '收到', download: null });
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/13b' }), ego);
  const r = await bridge.ask('chat', '在吗', { attachmentSavePath: join(TMP_HOME, 'no.md') });
  assert.equal(r.done, true);
  assert.equal(r.reply, '收到');
  assert.equal(ego.state.calls, 2, '短回复不该触发下载脚本');
  assert.ok(!('attachmentReply' in r));
}

// 14. 下载失败绝不能把一次成功的 ask 判死，只记 warning
{
  const md = `# 方案\n\n- 第一步\n- 第二步\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n${'- 补充说明，用来把回复撑到文件通道的门槛以上。\n'.repeat(60)}`;
  const ego = makeFakeEgo({ reply: md, download: async () => ({ error: '页面上找不到 .md 附件卡片' }) });
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/14' }), ego);
  const r = await bridge.ask('plan', '这次没有附件', { attachmentSavePath: join(TMP_HOME, 'none.md') });
  assert.equal(r.done, true);
  // 正文会过 cleanup（去尾部空白），所以按开头比对，不逐字比整段。
  assert.ok(r.reply.startsWith('# 方案'), r.reply.slice(0, 40));
  assert.ok(r.warnings.some((w) => w.includes('附件下载未完成')), JSON.stringify(r.warnings));
  assert.ok(!('attachmentReply' in r));
}

rmSync(TMP_HOME, { recursive: true, force: true });
console.log('bridge mock tests passed');
process.exit(0);