/**
 * dsh-hark-bridge 配置
 *
 * cordis 4.x 在启动插件前会执行
 *   runtime.Config['~standard'].validate(config)
 * 所以导出的 Config 必须是一个合法的 standard-schema v1 对象。
 *
 * schemastery 只当可选依赖用：插件既可以打包安装（依赖被提升到 profile 的
 * node_modules），也可以 `link:` 安装到一个任意目录——后者的真实路径在
 * profile 之外，`import('@deepseek-ai/schemastery')` 会解析失败。
 * 那种情况下退回下面内置的最小实现，而不是让 Config 退化成普通对象
 * （否则 cordis 取 `Config['~standard'].validate` 得到 undefined 而崩在激活阶段）。
 */

export const DEFAULT_CONFIG = {
  harkUrl: '',
  triggerWords: ['hark', 'Hark', '问 Hark', '让 Hark', '交给 Hark', '@hark'],
  browserPath: '',
  inputSelector: '',
  sendSelector: '',
  timeoutMin: 20,
  loginWaitSec: 120,
  pollMs: 2000,
  settleMs: 3000,
  maxChars: 60000,
};

const D = DEFAULT_CONFIG;

/**
 * 字段表。
 *
 * `volatile` 决定这个字段能否在 Web UI 里编辑：
 * dsh-settings 的 `volatileForm(schema)` 只收 `meta.volatile` 的节点，
 * 一个都没有时 `describe()` 直接跳过整个条目，浏览器侧拿不到表单，
 * 用户就只能在 YAML 里改配置。所以这里每个字段都标 volatile。
 *
 * `min`/`max` 是硬边界（审查意见）：配置写错不该让插件装不上，但也不能
 * 让一个手误的数字把行为搞崩——`pollMs: 0` 会不停读页面，`timeoutMin: 100000`
 * 会让工具调用卡到天荒地老。超出范围一律夹到边界值。
 */
/** @type {{key: string, kind: 'string'|'natural'|'words', min?: number, max?: number, description?: string}[]} */
const FIELDS = [
  { key: 'harkUrl', kind: 'string', description: 'Hark 对话页面地址（建议用专门的 Hark 项目页面，复制浏览器地址栏）' },
  { key: 'triggerWords', kind: 'words', description: '触发词：用户的话里出现这些词时，模型会调用 ask_hark' },
  { key: 'browserPath', kind: 'string', description: 'ego-browser 路径，留空自动查找' },
  { key: 'inputSelector', kind: 'string', description: '输入框 CSS 选择器，留空自动识别' },
  { key: 'sendSelector', kind: 'string', description: '发送按钮 CSS 选择器，留空自动识别' },
  { key: 'timeoutMin', kind: 'natural', min: 1, max: 120, description: '等待 Hark 回复的最长分钟数' },
  { key: 'loginWaitSec', kind: 'natural', min: 5, max: 600, description: '等待登录/输入框出现的秒数' },
  { key: 'pollMs', kind: 'natural', min: 200, max: 30000, description: '轮询页面文本的间隔毫秒数' },
  { key: 'settleMs', kind: 'natural', min: 0, max: 30000, description: '看到结束标记后再等多久确认稳定' },
  { key: 'maxChars', kind: 'natural', min: 1000, max: 400000, description: '单条消息字符上限' },
];

let Schema;
try {
  const mod = await import('@deepseek-ai/schemastery');
  const Candidate = mod.default || mod;
  // 只认真正带 standard-schema 接口的实现，避免拿到被 stub 掉的模块。
  if (typeof Candidate?.object === 'function') Schema = Candidate;
} catch { /* 走内置实现 */ }

/** 由 schemastery 生成的 schema（装得到 schemastery 时） */
function buildSchemastery(S) {
  const field = (f) => {
    let node;
    if (f.kind === 'words') node = S.array(S.string()).default(D[f.key]);
    else if (f.kind === 'natural') {
      node = S.natural().default(D[f.key]);
      if (typeof f.min === 'number') node = node.min(f.min);
      if (typeof f.max === 'number') node = node.max(f.max);
    } else node = S.string().default(D[f.key]);
    if (f.description) node = node.description(f.description);
    // 让该字段能被设置面板编辑（见文件顶部 volatile 说明）
    return node.volatile();
  };
  const shape = {};
  for (const f of FIELDS) shape[f.key] = field(f);
  return S.object(shape);
}

/** 把数字夹到字段声明的边界里；字段没写 min/max 就原样返回 */
function clamp(f, n) {
  let v = n;
  if (typeof f.min === 'number' && v < f.min) v = f.min;
  if (typeof f.max === 'number' && v > f.max) v = f.max;
  return v;
}

function toNatural(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.trunc(n);
}

function toWords(raw) {
  if (Array.isArray(raw)) {
    const list = raw.map((w) => String(w ?? '').trim()).filter(Boolean);
    return list.length ? list : undefined;
  }
  if (typeof raw === 'string') {
    const list = raw.split(/[,，、\n]/).map((w) => w.trim()).filter(Boolean);
    return list.length ? list : undefined;
  }
  return undefined;
}

/** 宽松修正：配置写错不该让插件装不上，非法值退回默认值，类型正确时原样保留 */
export function normalize(input) {
  const out = {};
  for (const f of FIELDS) {
    const fallback = D[f.key];
    const raw = input[f.key];
    if (raw === undefined || raw === null || raw === '') {
      out[f.key] = fallback;
      continue;
    }
    if (f.kind === 'natural') {
      const n = toNatural(raw);
      out[f.key] = n === undefined ? fallback : clamp(f, n);
    } else if (f.kind === 'words') {
      out[f.key] = toWords(raw) ?? fallback;
    } else {
      out[f.key] = typeof raw === 'string' ? raw : String(raw);
    }
  }
  return out;
}

/** 一个字段在内置实现里的 schemastery 形状节点 */
function fallbackNode(f) {
  // volatile 必须给到，否则设置面板的 volatileForm() 认不出可编辑字段，
  // 整条配置会被 describe() 跳过，用户在界面上看不到任何输入框。
  const meta = { default: D[f.key], volatile: true };
  if (f.description) meta.description = f.description;
  if (f.kind === 'natural') {
    meta.min = typeof f.min === 'number' ? f.min : 0;
    if (typeof f.max === 'number') meta.max = f.max;
    meta.step = 1;
  }
  const node = { type: f.kind === 'natural' ? 'number' : f.kind === 'words' ? 'array' : 'string', meta };
  if (f.kind === 'words') node.inner = { type: 'string', meta: {} };
  node.toString = () => `schemastery<${node.type}>`;
  return node;
}

/**
 * 内置实现。
 *
 * 两个独立契约都要满足，缺一个插件就装不上或面板不可编辑：
 *  1. cordis 启动插件前执行 `Config['~standard'].validate(config)` —— 需要 standard-schema v1；
 *  2. 设置面板用 `isNativeConfigSchema(Config)` 判断能否编辑 —— 需要
 *     `Config[Symbol.for('schemastery')] === true` 且 `type` 是字符串、`meta` 是对象。
 *
 * 只提供 1 会得到 status=unsupported（面板显示“不支持”），只提供 2 会在激活时
 * 崩在 `validate` 不是函数上，所以这里两者都补齐，并带上 type/meta/dict 结构，
 * 让面板仍然能按字段渲染。
 */
export function createFallbackConfig() {
  const dict = {};
  for (const f of FIELDS) dict[f.key] = fallbackNode(f);
  const Config = {
    type: 'object',
    meta: { default: {} },
    dict,
    '~standard': {
      version: 1,
      vendor: 'dsh-hark-bridge',
      validate(value) {
        return { value: normalize(value && typeof value === 'object' ? value : {}) };
      },
    },
    toString: () => 'schemastery<object>',
  };
  Object.defineProperty(Config, Symbol.for('schemastery'), { value: true, enumerable: false });
  return Config;
}

export const Config = Schema ? buildSchemastery(Schema) : createFallbackConfig();

/** 供测试断言：当前用的是真实 schemastery 还是内置实现 */
export const configSchemaBackend = Schema ? 'schemastery' : 'fallback';
