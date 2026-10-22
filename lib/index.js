/**
 * dsh-hark-bridge —— 让 DSH 把需求/代码交给 Hark，等 Hark 回方案或审查意见
 *
 * 提供：
 *  - 模型工具 ask_hark(mode, user_request, analysis, context?, questions?)
 *  - 命令 /hark <内容>        直接问 Hark
 *  - 命令 /hark-url <网址>    设置或查看 Hark 页面地址
 *  - 命令 /hark-login         Hark 页面切到前台（首次使用在那里登录）
 */
import { HarkBridge } from './bridge.js';
import { Config, DEFAULT_CONFIG } from './config-schema.js';
import { MODES } from './protocol.js';
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
    '  d. 把结果填进 analysis / context 参数，再调用。Hark 看不到本机文件，代码必须直接贴进 context。',
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

export function apply(ctx, config = {}) {
  const getConfig = () => {
    const out = {};
    for (const k of Object.keys(DEFAULT_CONFIG)) out[k] = unbox(config[k], DEFAULT_CONFIG[k]);
    // /hark-url 写入的覆盖层优先：cordis config 只能改 YAML 并重启，
    // 而页面地址是装完才知道的，得让用户当场设。
    const override = readOverride();
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (k in override) out[k] = unbox(override[k], DEFAULT_CONFIG[k]);
    }
    return out;
  };
  const bridge = new HarkBridge(getConfig);

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ask_hark',
    description: buildToolDescription(getConfig().triggerWords),
    parameters: {
      mode: { type: 'string', required: true, description: 'plan=要方案，review=要代码审查，chat=普通提问' },
      user_request: { type: 'string', required: true, description: '用户的原话（不要改写）' },
      analysis: { type: 'string', required: true, description: '你对需求的分析：目标、验收标准、涉及的模块/文件、技术栈与约束、你倾向的做法' },
      context: { type: 'string', description: '相关代码、目录结构；review 时放 git diff 与测试结果' },
      questions: { type: 'string', description: '你不确定、需要 Hark 拍板的点' },
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
      const r = await bridge.ask(args.mode, composeBody(args), { signal: exec?.signal });
      return r.reply;
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
          return { kind: 'success', text: (await bridge.ask('chat', text, { signal })).reply };
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
