/**
 * 用假的 ego 通道走一遍完整流程：选页 → 等输入框 → 输入 → 回车 → 等待结束标记
 *
 * 真的 ego 由 test/e2e-live.mjs 覆盖；这里只验证 bridge 的协议逻辑
 * （消息拼装、结束标记识别、握手、排队），不依赖任何浏览器。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// 必须在 import store 之前设好：store 在模块顶层就会读一次 dataDir()。
// 不隔离的话，握手记录会写进用户真实的 %LOCALAPPDATA%\dsh-hark-bridge\settings.json。
const TMP_HOME = mkdtempSync(join(tmpdir(), 'dsh-hark-test-'));
process.env.DSH_HARK_BRIDGE_HOME = TMP_HOME;

const { HarkBridge } = await import('../lib/bridge.js');
const { DEFAULT_CONFIG } = await import('../lib/config-schema.js');
const { endTag, footTag, buildRulesBody, RULES_VERSION } = await import('../lib/protocol.js');
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
  // 页面上「本次请求之后、Hark 回复里」的 md 卡片数。
  // 这是现在唯一决定要不要下载的信号（审查意见 B3）：以前靠正文长度和
  // Markdown 结构去猜，而 Hark 气泡显示的是渲染后的内容，猜中概率接近 0。
  mdCards = 0,
  // anchored：锚点（带请求编号的气泡）找没找到。真实实现里没锚点就一定不下载（N2）。
  anchored = true,
  mdTotal = 0,
  // lateCardAt：第几轮 poll 之后卡片才出现（模拟卡片比文字晚渲染，审查意见 N3）。
  // null 表示一直按 mdCards 给。
  lateCardAt = null,
  // throwAtPoll：第几轮 poll 时抛错（模拟宽限期内读页失败、ego 进程提前退出，
  // 审查意见 拍板 1）。null 表示不抛。
  throwAtPoll = null,
} = {}) {
  const state = { typed: '', calls: 0, all: [], scripts: [], staged: [], stagedContents: [] };
  const streamScript = async function* (script, { signal } = {}) {
    state.calls += 1;
    state.scripts.push(script);
    // 下载脚本是第二个独立脚本：它唯一的特征是 C.saveAs（要存到哪儿），
    // 不能再用 'data-dsh-md' 认——ask 脚本里也带这个表达式（每轮数卡片）。
    if (script.includes('"saveAs"')) {
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
    const nowStaged = stagedOf(script);
    state.staged.push(nowStaged);
    // 暂存目录在 ask 结束的 finally 里会被删掉，所以「附件里到底装了什么」必须
    // 在这里就地读下来——等价于浏览器在上传那一刻真的读到了这些字节。
    state.stagedContents.push(nowStaged.map((p) => {
      try { return readFileSync(p, 'utf8'); } catch { return ''; }
    }));
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
      if (throwAtPoll !== null && i >= throwAtPoll) {
        const e = new Error('Hark 页面忽然读不到内容了（可能被导航或关闭）');
        e.name = 'EgoStageError';
        e.stage = 'script';
        throw e;
      }
      // 完整页面长这样（导航栏在前，然后是我们的请求，之后是 Hark 的回复）
      const page = `导航栏\n${state.typed}\n${!neverReplies && i >= replyAfterPolls ? `${reply}\n${endTag(id)}` : ''}`;
      const at = page.indexOf(foot);
      // mdTotal：页面上卡片总数；mdCards：能算进本次请求的数量。
      // 真实实现里这两个数来自 DOM 位置比较，测试里直接给（anchored 有单独用例）。
      // lateCardAt：卡片晚于文字出现——文字早就定稿了，卡片还在路上。
      const cardsNow = lateCardAt !== null && i >= lateCardAt ? Math.max(mdCards, 1) : mdCards;
      yield at < 0
        ? { ok: true, phase: 'poll', sent: false, mdCards: cardsNow, anchored: false, mdTotal }
        : {
          ok: true,
          phase: 'poll',
          sent: true,
          text: page.slice(at + foot.length),
          mdCards: cardsNow,
          anchored,
          mdTotal: mdTotal || cardsNow,
        };
      await sleep(20);
    }
  };
  const runScript = async () => ({ ok: true, url: 'https://hark.example/p/1' });
  return { state, streamScript, runScript };
}

const URL1 = 'https://hark.example/p/1';
// attachGraceMs 压到很小：真实默认是 8000（等 Hark 的文件卡片出现），
// 但这里的假 ego 每 10ms 就推一次 poll、总共才推 20 次，按真实值永远等不到宽限期结束。
const baseCfg = {
  ...DEFAULT_CONFIG, harkUrl: URL1, pollMs: 10, settleMs: 10, attachGraceMs: 20,
};

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
  // 记的是「规则版本号」而不是「做过没」：改了规则文本就把 RULES_VERSION 加 1，
  // 老用户下次调用会自动补发一遍新规则。
  assert.equal(readOverride().handshakes?.[URL1], RULES_VERSION, '握手完成后要按规则版本号记下来');
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
  assert.equal(readOverride().handshakes?.[url3], RULES_VERSION);
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

// 5b. 超长正文 + autoAttachOverflow：改成附件发，不能截断（审查意见 S4）
//
// 截断是最糟的选择：超长正文几乎都是 diff，Hark 拿到半份代码会基于缺失上下文给方案。
// 所以这里既要不报错，也要保证正文一个字都没少——它得原样落在附件里。
{
  const ws = mkdtempSync(join(TMP_HOME, 'ws-'));
  const ego = makeFakeEgo();
  const long = 'diff --git a/x b/x\n' + '+ 这一行要原样到 Hark 手里\n'.repeat(20);
  const bridge = new HarkBridge(
    () => ({ ...baseCfg, harkUrl: 'https://hark.example/p/5b', maxChars: 200, autoAttachOverflow: true }),
    ego,
  );
  const r = await bridge.ask('plan', long, { workspaceRoot: ws });
  assert.equal(r.done, true, '转成附件后应当正常完成');
  assert.ok(
    (r.warnings || []).some((w) => /超过上限 200.*已改写成附件/.test(w)),
    `要说明正文被转成了附件，实际 warnings=${JSON.stringify(r.warnings)}`,
  );
  // 附件真的挂上去了
  const staged = ego.state.staged.at(-1) || [];
  assert.equal(staged.length, 1, '应当有一个正文附件');
  assert.match(staged[0], /正文-[a-z0-9]+\.md$/, `附件名应能看出是正文，实际 ${staged[0]}`);
  const uploaded = (ego.state.stagedContents.at(-1) || [])[0];
  assert.equal(uploaded, long, '附件里必须是完整正文，不能截断');
  // 输入框里只剩一句指路话（消息本身还有协议头与附件清单，所以不按总长度断言，
  // 只确认原始正文没有重复贴进来）
  assert.ok(!ego.state.typed.includes('+ 这一行要原样到 Hark 手里'), '正文不该再重复贴进输入框');
  assert.match(ego.state.typed, /完整内容已作为附件/, '要说清去看附件');
}

// 5c. 关掉 autoAttachOverflow 时仍然是明确的报错
{
  const ego = makeFakeEgo();
  const bridge = new HarkBridge(
    () => ({ ...baseCfg, harkUrl: 'https://hark.example/p/5c', maxChars: 50, autoAttachOverflow: false }),
    ego,
  );
  await assert.rejects(() => bridge.ask('plan', 'x'.repeat(80)), (e) => {
    assert.match(e.message, /超过上限 50/);
    return true;
  });
  assert.equal(ego.state.calls, 0, '关掉开关时不该启动浏览器');
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
  // 门控不再是「正文够不够长、像不像文档」，而是「页面上有没有 md 卡片」：
  // 所以这里 mdCards:1，正文写什么都行。
  const md = `# 方案\n\n- 第一步\n- 第二步\n\n> 引用\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n${'- 补充说明，用来把回复撑到文件通道的门槛以上。\n'.repeat(60)}`;
  const savePath = join(TMP_HOME, 'reply.md');
  const ego = makeFakeEgo({
    reply: '方案见附件 改锁方案.md',
    mdCards: 1,
    download: async () => { writeFileSync(savePath, md, 'utf8'); return { saved: savePath, name: '改锁方案.md' }; },
  });
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/13' }), ego);
  const r = await bridge.ask('plan', '给我一个 md', { attachmentSavePath: savePath });
  assert.equal(r.done, true);
  assert.equal(r.attachmentReply, md, 'attachmentReply 要等于下载到的文件内容');
  assert.equal(r.attachmentName, '改锁方案.md');
  // B3 的另一半：路径必须传到返回值上，否则上层那行「已下载」永远不出现。
  assert.equal(r.attachmentPath, savePath, 'attachmentPath 要一路传到返回值');
  assert.deepEqual(r.warnings, []);
}

// 13b. 页面上没有本次卡片就不下载：没卡片时去翻只会翻到别人留下的旧卡片
{
  const ego = makeFakeEgo({ reply: '收到', mdCards: 0, download: null });
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/13b' }), ego);
  const r = await bridge.ask('chat', '在吗', { attachmentSavePath: join(TMP_HOME, 'no.md') });
  assert.equal(r.done, true);
  assert.equal(r.reply, '收到');
  assert.equal(ego.state.calls, 2, '没有卡片时不该触发下载脚本');
  assert.ok(!('attachmentReply' in r));
}

// 13c. 正文很长但页面上没有卡片 → 仍然不下载
//
// 这正是 0.5.0 的真机故障：Hark 把长回复直接写在气泡里（没生成文件），
// 旧逻辑一看「够长、有结构」就去下载，结果翻到的是上一轮留下的旧卡片，
// 把不相干的内容当成本次回复。现在只看卡片数，长正文也照样直接读。
{
  const long = `# 很长的正文\n\n${'- 一条很长很长的说明，用来模拟 Hark 直接把长内容写在气泡里的情况。\n'.repeat(80)}`;
  const ego = makeFakeEgo({ reply: long, mdCards: 0, download: null });
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/13c' }), ego);
  const r = await bridge.ask('plan', '直接写在正文里', { attachmentSavePath: join(TMP_HOME, 'none2.md') });
  assert.equal(r.done, true);
  assert.equal(ego.state.calls, 2, '没有卡片就不该下载，正文多长都一样');
  assert.ok(r.reply.startsWith('# 很长的正文'));
  assert.ok(!('attachmentReply' in r));
}

// 13d. 没有锚点（找不到带请求编号的气泡）→ 绝不下载，即使页面上有卡片
//
// 这是审查意见 N2：请求气泡被渲染成「截断预览」时，里面没有 footTag，
// 早先的实现把 startAt 当成 -1 之后退化成全页筛选，于是取回上一轮的旧卡片，
// 还被 index.js 当成本次回复整段替换——模型拿着过期内容以为是新的。
{
  const ego = makeFakeEgo({
    reply: '方案见附件 旧的方案.md',
    mdCards: 0,
    anchored: false,
    mdTotal: 3,
    download: null,
  });
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/13d' }), ego);
  const r = await bridge.ask('plan', '锚点找不到', { attachmentSavePath: join(TMP_HOME, 'stale.md') });
  assert.equal(r.done, true);
  assert.equal(ego.state.calls, 2, '没锚点就不该跑下载脚本');
  assert.ok(!('attachmentReply' in r), '绝不能把旧卡片当本次回复');
  assert.ok(!('attachmentPath' in r));
  // 但要能看出发生过什么：页面上确实有卡片，却没一张算在本轮名下。
  assert.ok(
    r.warnings.some((w) => w.includes('没有一个能确认属于本次回复')),
    JSON.stringify(r.warnings),
  );
}

// 13e. 卡片比结束标记晚到：plan/review 要等一个宽限期，等到了就下载
//
// 这是审查意见 N3：Hark 先渲染文字气泡（结尾是结束标记），文件卡片要等上传完
// 才出现，通常慢一两秒。settle 只保证文字稳定，若此时立刻判「没卡片」，
// plan/review 的文件通道就整个形同虚设。
{
  const md = '# 迟到的方案\n\n- 第一步\n';
  const savePath = join(TMP_HOME, 'late.md');
  const ego = makeFakeEgo({
    reply: '方案见附件 迟到的方案.md',
    // 前面几轮 0 张，之后 1 张：模拟卡片在文字定稿后才渲染出来。
    // 第 5 轮才出现，确保文字定稿（第 2 轮）之后确实经历过「有锚点但没卡片」的宽限期。
    mdCards: 0,
    lateCardAt: 5,
    download: async () => { writeFileSync(savePath, md, 'utf8'); return { saved: savePath, name: '迟到的方案.md' }; },
  });
  const bridge = new HarkBridge(
    () => ({ ...baseCfg, harkUrl: 'https://hark.example/p/13e', attachGraceMs: 2000 }),
    ego,
  );
  const r = await bridge.ask('plan', '等卡片', { attachmentSavePath: savePath });
  assert.equal(r.done, true);
  assert.equal(r.attachmentReply, md, '宽限期内出现的卡片要能拿到');
  assert.equal(r.attachmentPath, savePath);
}

// 13f. chat 模式不等卡片：闲聊多等 8 秒纯属浪费
//
// 卡片到很晚才出现（第 12 轮），chat 在文字定稿时就该走人，等不到它。
{
  const ego = makeFakeEgo({ reply: '收到', mdCards: 0, lateCardAt: 12, download: null });
  const bridge = new HarkBridge(
    () => ({ ...baseCfg, harkUrl: 'https://hark.example/p/13f', attachGraceMs: 2000 }),
    ego,
  );
  const t0 = Date.now();
  const r = await bridge.ask('chat', '在吗', { attachmentSavePath: join(TMP_HOME, 'chat.md') });
  assert.equal(r.done, true);
  assert.equal(ego.state.calls, 2, 'chat 不下载');
  assert.ok(Date.now() - t0 < 1500, `chat 不该等宽限期，实际用了 ${Date.now() - t0}ms`);
}

// 13g. 宽限期内出错，已定稿的回复必须保住（审查意见 拍板 1）
//
// 文字早就写完了，只是卡片没等到；此时读页抛错（页面被导航、ego 提前退出、
// streamScript 的 timeoutMs 抢先触发），若直接上抛，用户会看到「这次失败了」，
// 而实际上完整回复已经在手上——他要为一张拿不到的卡片重跑几十秒。
{
  const ego = makeFakeEgo({
    reply: '方案：\n1. 先改锁',
    mdCards: 0,
    // 第 4 轮抛错：文字在第 2 轮就定稿了，此时正处在宽限期里。
    throwAtPoll: 4,
    download: null,
  });
  const bridge = new HarkBridge(
    () => ({ ...baseCfg, harkUrl: 'https://hark.example/p/13g', attachGraceMs: 2000 }),
    ego,
  );
  const r = await bridge.ask('plan', '宽限期里出错', { attachmentSavePath: join(TMP_HOME, 'g.md') });
  assert.equal(r.done, true, '已经定稿的回复不能报失败');
  assert.equal(r.reply, '方案：\n1. 先改锁');
  assert.equal(ego.state.calls, 2, '没卡片就不该跑下载脚本');
  assert.ok(
    r.warnings.some((w) => w.includes('回复已定稿，但等待附件卡片时出错')),
    JSON.stringify(r.warnings),
  );
}

// 13h. 取消仍然是取消，不能被 settled 兜底吞掉（审查意见 拍板 1 的反面）
//
// 兜底只看「有没有定稿」，但用户按下停止时，哪怕文字已经完整也必须原样抛
// AbortError：模型要能区分「拿到了但用户不要了」和「拿到了」。
{
  const ego = makeFakeEgo({ reply: '方案：\n1. 先改锁', mdCards: 0, download: null });
  const bridge = new HarkBridge(
    () => ({ ...baseCfg, harkUrl: 'https://hark.example/p/13h', attachGraceMs: 5000 }),
    ego,
  );
  const ac = new AbortController();
  const p = bridge.ask('plan', '发完就取消', { signal: ac.signal, attachmentSavePath: join(TMP_HOME, 'h.md') });
  setTimeout(() => ac.abort(new Error('用户按了停止')), 120);
  await assert.rejects(p, (e) => e.name === 'AbortError', '取消必须原样上抛');
}


{
  const md = `# 方案\n\n- 第一步\n- 第二步\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n${'- 补充说明，用来把回复撑到文件通道的门槛以上。\n'.repeat(60)}`;
  const ego = makeFakeEgo({
    reply: md,
    mdCards: 1,
    download: async () => ({ error: '页面上找不到 .md 附件卡片' }),
  });
  const bridge = new HarkBridge(() => ({ ...baseCfg, harkUrl: 'https://hark.example/p/14' }), ego);
  const r = await bridge.ask('plan', '这次没有附件', { attachmentSavePath: join(TMP_HOME, 'none.md') });
  assert.equal(r.done, true);
  // 正文会过 cleanup（去尾部空白），所以按开头比对，不逐字比整段。
  assert.ok(r.reply.startsWith('# 方案'), r.reply.slice(0, 40));
  assert.ok(r.warnings.some((w) => w.includes('附件下载未完成')), JSON.stringify(r.warnings));
  assert.ok(!('attachmentReply' in r));
  assert.ok(!('attachmentPath' in r), '下载失败时不该编造路径');
}

rmSync(TMP_HOME, { recursive: true, force: true });
console.log('bridge mock tests passed');
process.exit(0);