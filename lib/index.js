/**
 * dsh-hark-bridge —— 让 DSH 把需求/代码交给 Hark，等 Hark 回方案或审查意见
 *
 * 提供：
 *  - 模型工具 ask_hark(mode, user_request, analysis, context?, questions?, attachments?)
 *  - 命令 /hark <内容>        直接问 Hark
 *  - 命令 /hark-url <网址>    设置或查看 Hark 页面地址
 *  - 命令 /hark-login         Hark 页面切到前台（首次使用在那里登录）
 *
 * 双向文件传递（0.5.0）：
 *  - 上行：attachments 传工作区相对路径，插件校验后暂存、作为附件发给 Hark；
 *  - 下行：Hark 的回复同时存成 Markdown 文件，Hark 附带的 .md 附件优先下载。
 * 为什么要落盘：长方案/审查意见几万字，塞进对话上下文既贵又难读，落盘之后
 * 用户可以直接在编辑器里打开、对照着改，模型上下文里只留一句「存到哪了」。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupStaleStaging } from './attach.js';
import { HarkBridge } from './bridge.js';
import { Config, DEFAULT_CONFIG, normalize } from './config-schema.js';
import { cleanupTempDirs } from './ego.js';
import { MODES } from './protocol.js';
import { renameDownloaded, resolveReplyDir, saveReply } from './reply-store.js';
import { normalizeUrl, readOverride, setWorkspaceRoot, storePath, writeOverride } from './store.js';

export const name = 'hark-bridge';
// cordis 4.x 把 inject 读成「服务名数组」（或 { required, optional } 之外的映射）；
// 写成 { required: [...], optional: [...] } 会被当成 name->config 映射，
// 服务名变成字符串 "required"/"optional"，插件永远停在 PENDING，apply 根本不会执行。
// commands 是可选服务，所以不写进 inject，改用 ctx.get('commands') 运行时探测。
export const inject = ['tools'];
export { Config };

// 降级路径也必须产出合法 JSON Schema：工具定义里 parameters 写的是 DSL
// （{ 字段: { type, required: true } }），它缺顶层 type:'object'，required 也不是
// 数组。原样交给宿主，模型看到的参数定义就是错的（required 失效），而 import 失败
// 只在测试环境或依赖缺失时发生，正是没人盯着的场景。
function specToJsonSchema(spec) {
  const properties = {};
  const required = [];
  for (const [key, raw] of Object.entries(spec || {})) {
    const { required: isReq, ...node } = raw;
    if (isReq === true) required.push(key);
    if (node.type === 'object' && node.properties && !Array.isArray(node.required)) {
      const inner = specToJsonSchema(node.properties);
      node.properties = inner.properties;
      if (inner.required) node.required = inner.required;
    }
    properties[key] = node;
  }
  const out = { type: 'object', properties };
  if (required.length) out.required = required;
  return out;
}
let defineTool = (def) => ({ ...def, parameters: specToJsonSchema(def.parameters) });
try {
  const mod = await import('@deepseek-ai/dsh-tools');
  if (typeof mod.defineTool === 'function') defineTool = mod.defineTool;
} catch { /* 测试环境 */ }

function unbox(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'object' && typeof v.get === 'function') {
    const raw = v.get();
    return raw === undefined || raw === null || raw === '' ? fallback : raw;
  }
  return v;
}

/** 触发词 + 先分析再发送的规则，进入模型的工具说明 */
export function buildToolDescription(triggerWords) {
  const words = (triggerWords || []).map((w) => String(w ?? '').trim()).filter(Boolean).map((w) => `「${w}」`).join('、');
  // 用户把 triggerWords 清空时不能留一个空槽，否则句子会读成「出现  等字样时必须使用本工具」，
  // 变成无条件强制调用。
  const when = words
    ? `【何时调用】用户的话里出现 ${words} 等字样时使用本工具；`
    : '【何时调用】需要外部方案设计或代码审查时使用本工具；';
  return [
    '把需求或代码交给 Hark（另一个 AI，负责方案设计与代码审查），等待其回复，可能需要几分钟。',
    `${when}涉及多个文件的较大开发需求，应先找 Hark 要方案。`,
    '【调用前必须先分析，不要原样转发用户的话】',
    '  a. 读懂用户要什么：目标、验收标准、隐含约束；',
    '  b. 自己查看项目：目录结构、相关文件和关键代码、技术栈、现有约定；',
    '  c. 列出你不确定、需要 Hark 决定的点；',
    '  d. 把结果填进 analysis / context 参数，再调用。Hark 看不到本机文件：短片段直接贴进 context，长方案、整份代码、diff 用 attachments 传工作区相对路径（省上下文也更保真）。',
    '【返回值是文件路径，不是全文】回复会存成工作区里的 Markdown 文件，返回值只带「已保存到 …」和开头一小段。看到这个就先读那个文件，再动手实现或按审查意见改；只看预览会漏掉后半截要求。',
    '【协作流程】',
    '  1) mode="plan" 拿实施方案；',
    '  2) 按方案拆任务，派子代理并行实现，跑测试；',
    '  3) mode="review"，context 放 git diff 和测试结果，按“必须修改”逐条改，必要时再 review，直到结论为“通过”。',
  ].join('\n');
}

/** 把结构化参数组装成发给 Hark 的正文 */
export function composeBody(args) {
  const sec = (title, v) => (typeof v === 'string' && v.trim() ? `## ${title}\n${v.trim()}` : '');
  return [
    sec('用户原话', args.user_request),
    sec('DSH 的分析', args.analysis),
    sec('需要 Hark 决定的问题', args.questions),
    sec('项目上下文 / 代码', args.context),
  ].filter(Boolean).join('\n\n');
}

/**
 * 工作区根目录。
 *
 * 优先用 exec 上下文里的会话 cwd —— 那才是"用户此刻在哪个项目里"，
 * 而 process.cwd() 是 DSH 进程自己的启动目录，两者常常不是一回事。
 * 取不到才退回 process.cwd()：至少落盘位置是确定的，不会因为拿不到上下文而失败。
 */
export function resolveWorkspaceRoot(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  if (typeof cwd === 'string' && cwd.trim()) return cwd;
  return process.cwd();
}

/**
 * 把一次 ask 的结果排版成工具返回值。
 *
 * 为什么不在返回值里放全文：方案/审查动辄上万字，全塞进上下文既贵又会把
 * 后面的对话挤掉。这里给「文件路径 + 摘要/前若干字」，模型要看细节可以自己读文件。
 * 文件没存成时才退化成返回全文——这样至少不会什么都没给模型。
 */
export function formatAskResult(result, { inlineMaxChars = 20_000, replyPath = '' } = {}) {
  const reply = String(result?.reply ?? '');
  const lines = [];
  const head = [`请求编号 ${result?.id}`, `模式 ${result?.mode || ''}`.trim()].filter(Boolean).join('　');
  if (head) lines.push(head);

  if (replyPath) {
    // 只有附件时 replyPath 就是附件路径（不另存副本，审查意见 S-d）。
    // 那也得说清这个文件是 Hark 自己给的原文，不是我们从气泡里抄下来的——
    // 模型据此决定要不要直接读它、能不能当准稿。
    const isAttachment = Boolean(result?.attachmentPath) && result.attachmentPath === replyPath;
    if (isAttachment) {
      const name = result?.attachmentName ? `（${result.attachmentName}）` : '';
      lines.push(`📄 Hark 附带的文件已下载${name}：${replyPath}`);
      lines.push('（这是 Hark 生成的原文；需要全文请直接读这个文件，下面只是开头部分。）');
    } else {
      lines.push(`📄 完整回复已保存：${replyPath}`);
      lines.push('（需要全文请直接读这个文件；下面只是开头部分。）');
    }
    const preview = reply.slice(0, 1200);
    lines.push('', preview + (reply.length > 1200 ? '\n…（已截断）' : ''));
  } else {
    // 没落盘就只能把正文给出去；超过 inlineMaxChars 仍然要截，否则一个超长回复
    // 能把后面整段对话挤爆。
    lines.push('', reply.length > inlineMaxChars
      ? `${reply.slice(0, inlineMaxChars)}\n…（已截断，共 ${reply.length} 字符）`
      : reply);
  }

  // 附件单独说一句（审查意见 N4）：光给路径，模型不知道那个文件是「这次的产物」
  // 还是「顺手存下来的东西」，也就不会去读它。
  // 只有附件、没再存副本时 replyPath 就是附件路径，上面已经说过了，别重复。
  if (result?.attachmentPath && result.attachmentPath !== replyPath) {
    const name = result?.attachmentName ? `（${result.attachmentName}）` : '';
    lines.push('', `📎 Hark 附带的文件已下载${name}：${result.attachmentPath}`);
  }
  const attached = Array.isArray(result?.attached) ? result.attached : [];
  if (attached.length) lines.push('', `已上传附件：${attached.join('、')}`);
  if (result?.attachMode === 'inline') lines.push('', '（附件未能上传，已改为把文件内容贴在消息正文里）');
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  if (warnings.length) lines.push('', ...warnings.map((w) => `⚠️ ${w}`));
  return lines.join('\n').trim();
}

/** /hark-url 不带参数时，说清楚当前用的是哪来的值 */
export function describeUrl(current) {
  const source = 'harkUrl' in readOverride() ? '由 /hark-url 设置' : '来自插件配置（cordis.yml）';
  if (!current) {
    return [
      '还没有设置 Hark 地址。',
      '用法：/hark-url https://…（在已登录 Hark 的浏览器里打开对话页面，复制地址栏的地址）',
      `也可以直接编辑：${storePath()}`,
    ].join('\n');
  }
  return `当前 Hark 地址：${current}\n来源：${source}\n改地址：/hark-url <新网址>`;
}

/**
 * 把自检结果排成人能一眼看懂的清单。
 *
 * 三态而不是两态：`ok === null` 表示「查到了，但不构成错误」（比如还没握手、
 * 页面上暂时没有附件卡片）。把它们和失败混在一起，用户会以为处处是问题；
 * 全部省略，又会漏掉「知道但要注意」的信息。
 * @param {Array<{name: string, ok: boolean|null, detail: string, hint?: string}>} rows
 */
export function formatDiagnosis(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '自检没有返回任何结果，请把这条命令的输出发给维护者。';
  const mark = (ok) => (ok === true ? '✅' : ok === false ? '❌' : '•');
  const lines = list.map((r) => {
    const head = `${mark(r.ok)} ${r.name}：${r.detail || ''}`.trimEnd();
    return r.hint ? `${head}\n   → ${r.hint}` : head;
  });
  const bad = list.filter((r) => r.ok === false).length;
  const tail = bad
    ? `\n\n有 ${bad} 项没通过：按上面的 → 逐条处理，改完再执行一次 /hark-diag。`
    : '\n\n全部通过。如果 ask_hark 仍然失败，请把这份输出和错误信息一起发给维护者。';
  return lines.join('\n') + tail;
}

export function apply(ctx, config = {}, deps = {}) {
  // 上次运行被杀掉的子进程可能留下临时目录（Windows 上文件还被占着时删不掉），
  // 启动时顺手清一遍，不然它们会一直堆在 temp 里。
  try { cleanupTempDirs(); } catch { /* 清理失败不影响干活 */ }

  const getConfig = () => {
    const out = {};
    for (const k of Object.keys(DEFAULT_CONFIG)) out[k] = unbox(config[k], DEFAULT_CONFIG[k]);
    // /hark-url 写入的覆盖层优先：cordis config 只能改 YAML 并重启，
    // 而页面地址是装完才知道的，得让用户当场设。
    const override = readOverride();
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (k in override) out[k] = unbox(override[k], DEFAULT_CONFIG[k]);
    }
    // 覆盖层是手可改的 JSON，同样要过一遍校验：否则一个手误的字符串数字
    // 会让 timeoutMin * 60_000 变成 NaN，定时器永远不触发（审查意见）。
    return normalize(out);
  };
  // deps 只给测试用：注入假的 ego 通道，就能在不碰真浏览器的情况下
  // 验证「发请求 → 落盘 → 返回值排版」整条链。生产代码不传。
  const bridge = new HarkBridge(getConfig, deps.bridge || {});

  /**
   * 发一次请求并把回复落盘，返回给模型看的文本。
   *
   * 落盘目录先算好、先建出来，再交给 bridge 当附件下载目录：Hark 附带的 .md
   * 会直接写进同一个目录，用户在一个地方就能看到「它的回复」和「它给的文件」。
   * 目录算不出来（比如 replyDir 配错越界）只降级成「不落盘」，不阻断对话。
   */
  async function askAndStore({ mode, body, attachments, signal, exec, warnings: extra }) {
    const cfg = getConfig();
    const workspaceRoot = resolveWorkspaceRoot(exec);
    const warnings = Array.isArray(extra) ? extra : [];

    // 工作区根目录告诉 store.js：全局配置写不进去时（部署方只给工作区写权限），
    // 覆盖层要能落到 <工作区>/.hark/settings.json。
    try { setWorkspaceRoot(workspaceRoot); } catch { /* 设不上就只用全局层 */ }

    // 崩溃残留的暂存目录在这里清（审查意见 S6）：只有这时才知道工作区在哪。
    // 24 小时以前的才删——刚起来的另一个会话可能正在往里写。
    try { cleanupStaleStaging(join(workspaceRoot, '.hark', 'attach')); } catch { /* 清理失败不影响对话 */ }

    // 这个目录有两个用途，必须分开看：
    //   1. 下载 Hark 附带的 .md —— 只要 fetchAttachment 开着就该做，和「存不存正文」无关；
    //   2. 存聊天正文（saveReply）—— 才受 saveReplies 控制。
    // 早先把两件事绑在 `if (cfg.saveReplies)` 里，于是关掉落盘的人连附件都拿不到，
    // 明明是独立的开关。
    let replyDirAbs = '';
    try {
      replyDirAbs = resolveReplyDir({ workspaceRoot, replyDir: cfg.replyDir });
      mkdirSync(replyDirAbs, { recursive: true });
    } catch (e) {
      replyDirAbs = '';
      warnings.push(`回复文件没能保存：${e?.message || e}`);
    }

    const r = await bridge.ask(mode, body, {
      signal,
      // 模型给的是工作区相对路径，交给 bridge 去校验、暂存、算上传名——
      // 校验逻辑（越界、敏感文件、大小）只在 attach.js 里有一份。
      attachmentPaths: attachments,
      workspaceRoot,
      // 附件名留 <id> 占位，真正的编号在 bridge 里生成；降级重发换 id 时文件名也跟着换，
      // 不会出现「返回的 id 和磁盘上的文件名对不上」。
      attachmentSaveDir: replyDirAbs || '',
      attachmentSaveName: '<id>.hark.md',
      // 下载完改成规范名。下载那一刻才知道卡片名（那是 Hark 给这份文档起的标题），
      // 比 `<id>.hark.md` 有用得多——用户在资源管理器里要按名字找得到。
      renameAttachment: ({ saved, name, text, mode: m }) => renameDownloaded({ saved, name, text, mode: m }),
    });

    const merged = { ...r, mode, warnings: [...(r.warnings || []), ...warnings] };
    let replyPath = '';
    const gotFile = typeof merged.attachmentReply === 'string' && merged.attachmentReply.trim();
    // 落盘内容 = 附件原文 + 聊天正文（审查意见 N4）。
    //
    // 为什么不能整段替换成附件原文：Hark 的聊天正文里常带文件之外的信息——
    // 「无法生成文件」、对某个具体问题的直接回答、改哪个文件的补充说明。
    // 只留附件就把这些丢了。
    // 为什么附件必须在前：附件是原文（Markdown 结构完整），聊天正文是渲染后的，
    // 拿它落盘存下的是一份「看着像文档、实际没法再加工」的文本。
    const chat = String(merged.reply || '').trim();
    // 聊天正文常常只是「方案见附件 xxx.md」这一句，和附件一字不差时不必重复。
    const keepChat = chat && chat !== gotFile;
    // 只对模型可见的合并文本：附件原文 + 聊天正文。
    const text = gotFile
      ? (keepChat ? `${gotFile}\n\n---\n\n（Hark 聊天正文）\n\n${chat.slice(0, 1500)}` : gotFile)
      : chat;
    // 拿到附件就不再另存一份（审查意见 S-d）。
    //
    // 早先的写法是「正文和附件不同就再 saveReply 一份」，可附件几乎总比正文长
    // （正文只是「见附件」），于是条件恒真、磁盘上永远躺着两个字节接近的 .md，
    // 用户不知道该看哪个。附件本身已经是原文、已经在回复目录里，它就是这份回复。
    // 聊天正文没有丢——它在 text 里、在给模型的返回值里；只是不再单独落一个文件。
    const onlyAttachment = Boolean(gotFile) && Boolean(merged.attachmentPath);
    if (onlyAttachment) {
      // 附件是 Hark 给的原文，它就在回复目录里——不落盘开关不该影响它。
      replyPath = merged.attachmentPath;
    } else if (cfg.saveReplies) {
      // 短回复不落盘：一句话的回答直接给正文最省事——模型不用为一个「收到」去多读
      // 一个文件，用户的工作区也不会被一堆两行的小文件塞满。
      const worthFile = text.trim().length >= (cfg.markdownMinChars ?? 1200);
      if (replyDirAbs && text.trim() && worthFile) {
        try {
          const requestLine = String(body).split('\n')[0].slice(0, 120);
          const saved = saveReply({
            dir: replyDirAbs,
            id: merged.id,
            mode,
            reply: text,
            // 没有标题的短回复也要有个看得懂的名字：退回请求编号只会得到
            // `20261023-130735-chat-idn1voy2s.md`，在资源管理器里等于没名字。
            request: requestLine,
            meta: {
              request: requestLine,
              attachments: Array.isArray(merged.attached) ? merged.attached.join(', ') : '',
              // 记下这份内容从哪来：气泡文本是有损的（Markdown 已被渲染掉），
              // 出了问题要能一眼看出存的是不是原文。
              source: gotFile ? 'hark-attachment' : 'innertext',
            },
          });
          replyPath = saved.rel;
        } catch (e) {
          merged.warnings.push(`回复文件没能保存：${e?.message || e}`);
        }
      }
    }
    // 给模型看的内容也换成「原文 + 聊天正文」：它接下来要按这份内容干活
    // （改代码、写文档），拿到渲染后的文本会漏掉所有 Markdown 结构；
    // 只给附件原文又会丢掉聊天里那句补充说明（审查意见 N4）。
    // 用 text（= 落盘的同一份内容），返回值预览与文件内容才对得上。
    if (gotFile) merged.reply = text;
    return formatAskResult(merged, { replyPath });
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ask_hark',
    description: buildToolDescription(getConfig().triggerWords),
    parameters: {
      mode: { type: 'string', required: true, description: 'plan=要方案，review=要代码审查，chat=普通提问' },
      user_request: { type: 'string', required: true, description: '用户的原话（不要改写）' },
      analysis: { type: 'string', required: true, description: '你对需求的分析：目标、验收标准、涉及的模块/文件、技术栈与约束、你倾向的做法' },
      context: { type: 'string', description: '相关代码、目录结构；review 时放 git diff 与测试结果' },
      questions: { type: 'string', description: '你不确定、需要 Hark 拍板的点' },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description: '要作为文件发给 Hark 的附件，传工作区相对路径（如 docs/plan.md）。'
          + '长方案、成段代码、diff 优先用附件而不是塞进 context，省上下文也更清楚。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      // 不做 String() 转换：对象参数会变成 "[object Object]" 混过检查。
      if (typeof args?.analysis !== 'string' || !args.analysis.trim()) {
        throw new Error('analysis 不能为空：请先分析需求和项目再调用');
      }
      if (!MODES.includes(args.mode)) {
        throw new Error(`mode 只能是 ${MODES.join(' / ')}，收到：${args.mode}`);
      }
      // 超时/取消都在 bridge 里抛错，不会把半截回复当结论返回。
      return askAndStore({
        mode: args.mode,
        body: composeBody(args),
        attachments: args.attachments,
        signal: exec?.signal,
        exec,
      });
    },
  })), 'dsh-hark-bridge: ask_hark tool');

  // commands 是可选服务：cordis 的 ctx.commands 在未注入时会抛
  // "cannot get property without inject"，必须用 ctx.get 探测。
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : ctx.commands;
  if (commands) {
    ctx.effect(() => commands.register({
      name: 'hark-url',
      description: '设置或查看 Hark 对话页面的地址',
      input: { hint: '<网址>' },
      handler: async ({ rawInput, agent }) => {
        // 命令上下文里带 agent，能取到当前会话的工作区。不设的话，
        // 「全局写不进去要退回工作区」这条兜底在首次设置时就失效了——
        // 而那恰恰是最需要它的时刻（新装的环境、受限的部署）。
        try { setWorkspaceRoot(resolveWorkspaceRoot({ agent })); } catch { /* 取不到就只用全局层 */ }
        const text = String(rawInput ?? '').trim();
        if (!text) {
          // 还没设地址时顺手看一眼 ego 里开着的标签页：用户多半已经登着 Hark，
          // 让他复制粘贴既多余又容易复制错（项目列表页、带一堆查询参数的地址），
          // 而复制错的表现是「连上了但发消息没反应」，比没配更难查。
          if (!getConfig().harkUrl) {
            try {
              const tabs = await bridge.detectHarkTabs();
              if (tabs.length) {
                const list = tabs.slice(0, 5).map((t) => `  ${t.url}${t.title ? `（${t.title}）` : ''}`).join('\n');
                return {
                  kind: 'success',
                  text: [
                    '还没有设置 Hark 地址，但在 ego 里发现了这些 Hark 页面：',
                    list,
                    '',
                    '如果是其中某一个，执行 /hark-url <上面那个完整地址> 采用它。',
                    '（要确认是你平时对话的那个项目页，不是项目列表页。）',
                    // 探测到的候选是「锦上添花」，不能因此把「怎么手改」这条兜底信息挤掉：
                    // 用户可能开着好几个 Hark 项目，或者那个标签页根本不该用。
                    `也可以直接编辑：${storePath()}`,
                  ].join('\n'),
                };
              }
            } catch { /* 探测失败不影响正常提示 */ }
          }
          return { kind: 'success', text: describeUrl(getConfig().harkUrl) };
        }
        const parsed = normalizeUrl(text);
        if (!parsed.ok) return { kind: 'error', text: parsed.error };
        try {
          writeOverride({ harkUrl: parsed.url });
        } catch (e) {
          return { kind: 'error', text: `写入配置失败：${e?.message || e}` };
        }
        return { kind: 'success', text: `已保存 Hark 地址：${parsed.url}\n可以用 /hark-login 把页面切到前台确认一下。` };
      },
    }), 'dsh-hark-bridge: /hark-url');

    ctx.effect(() => commands.register({
      name: 'hark',
      description: '直接给 Hark 发消息并等待回复',
      input: { hint: '<内容>' },
      handler: async ({ rawInput, signal, agent }) => {
        const text = String(rawInput ?? '').trim();
        if (!text) return { kind: 'error', text: '用法：/hark <内容>' };
        try {
          return {
            kind: 'success',
            // 命令的调用上下文里带着 agent（审查意见 S3）：不传的话
            // askAndStore 只能退回 process.cwd()，那是 DSH 进程的启动目录，
            // 于是 /hark 的回复会落进一个跟当前项目无关的文件夹。
            text: await askAndStore({ mode: 'chat', body: text, signal, exec: { agent } }),
          };
        } catch (e) {
          return { kind: 'error', text: `Hark 桥接失败：${e?.message || e}` };
        }
      },
    }), 'dsh-hark-bridge: /hark');

    ctx.effect(() => commands.register({
      name: 'hark-login',
      description: '把 Hark 页面切到前台（首次使用在那里登录）',
      handler: async () => {
        try { return { kind: 'success', text: await bridge.openForLogin() }; }
        catch (e) { return { kind: 'error', text: `打开失败：${e?.message || e}` }; }
      },
    }), 'dsh-hark-bridge: /hark-login');

    ctx.effect(() => commands.register({
      name: 'hark-diag',
      description: '自检：逐项检查 ego、地址、登录态和页面锚点',
      handler: async () => {
        try {
          const rows = await bridge.diagnose();
          return { kind: 'success', text: formatDiagnosis(rows) };
        } catch (e) {
          return { kind: 'error', text: `自检失败：${e?.message || e}` };
        }
      },
    }), 'dsh-hark-bridge: /hark-diag');
  }
}
