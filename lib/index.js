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
import { HarkBridge } from './bridge.js';
import { Config, DEFAULT_CONFIG, normalize } from './config-schema.js';
import { cleanupTempDirs } from './ego.js';
import { MODES } from './protocol.js';
import { resolveReplyDir, saveReply } from './reply-store.js';
import { normalizeUrl, readOverride, storePath, writeOverride } from './store.js';

export const name = 'hark-bridge';
// cordis 4.x 把 inject 读成「服务名数组」（或 { required, optional } 之外的映射）；
// 写成 { required: [...], optional: [...] } 会被当成 name->config 映射，
// 服务名变成字符串 "required"/"optional"，插件永远停在 PENDING，apply 根本不会执行。
// commands 是可选服务，所以不写进 inject，改用 ctx.get('commands') 运行时探测。
export const inject = ['tools'];
export { Config };

let defineTool = (def) => def;
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
    lines.push(`📄 完整回复已保存：${replyPath}`);
    lines.push('（需要全文请直接读这个文件；下面只是开头部分。）');
    const preview = reply.slice(0, 1200);
    lines.push('', preview + (reply.length > 1200 ? '\n…（已截断）' : ''));
  } else {
    // 没落盘就只能把正文给出去；超过 inlineMaxChars 仍然要截，否则一个超长回复
    // 能把后面整段对话挤爆。
    lines.push('', reply.length > inlineMaxChars
      ? `${reply.slice(0, inlineMaxChars)}\n…（已截断，共 ${reply.length} 字符）`
      : reply);
  }

  if (result?.attachmentPath) lines.push('', `📎 Hark 附带的文件已下载：${result.attachmentPath}`);
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

    let replyDirAbs = '';
    if (cfg.saveReplies) {
      try {
        replyDirAbs = resolveReplyDir({ workspaceRoot, replyDir: cfg.replyDir });
        mkdirSync(replyDirAbs, { recursive: true });
      } catch (e) {
        replyDirAbs = '';
        warnings.push(`回复文件没能保存：${e?.message || e}`);
      }
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
    });

    const merged = { ...r, mode, warnings: [...(r.warnings || []), ...warnings] };
    let replyPath = '';
    // 短回复不落盘：一句话的回答直接给正文最省事——模型不用为一个「收到」去多读
    // 一个文件，用户的工作区也不会被一堆两行的小文件塞满。方案和审查这类长内容
    // 才值得写文件（返回值里给路径 + 开头预览，模型要看细节自己读）。
    const worthFile = String(merged.reply || '').length >= (cfg.markdownMinChars ?? 1200);
    if (replyDirAbs && merged.reply && worthFile) {
      try {
        const saved = saveReply({
          dir: replyDirAbs,
          id: merged.id,
          mode,
          reply: merged.reply,
          meta: {
            request: String(body).split('\n')[0].slice(0, 120),
            attachments: Array.isArray(merged.attached) ? merged.attached.join(', ') : '',
          },
        });
        replyPath = saved.rel;
      } catch (e) {
        merged.warnings.push(`回复文件没能保存：${e?.message || e}`);
      }
    }
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
      handler: async ({ rawInput }) => {
        const text = String(rawInput ?? '').trim();
        if (!text) return { kind: 'success', text: describeUrl(getConfig().harkUrl) };
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
      handler: async ({ rawInput, signal }) => {
        const text = String(rawInput ?? '').trim();
        if (!text) return { kind: 'error', text: '用法：/hark <内容>' };
        try {
          return {
            kind: 'success',
            text: await askAndStore({ mode: 'chat', body: text, signal }),
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
  }
}
