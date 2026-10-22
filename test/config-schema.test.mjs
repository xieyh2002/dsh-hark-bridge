import assert from 'node:assert/strict';
import { Config, DEFAULT_CONFIG, configSchemaBackend, createFallbackConfig } from '../lib/config-schema.js';

/**
 * cordis 4.x 的 isNativeConfigSchema 原型（从 @deepseek-ai/dsh-app-boot 抄的判定）。
 * 设置面板靠它决定 Config 是可编辑（status=schema）还是 unsupported。
 */
const isNativeConfigSchema = (value) => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const meta = Reflect.get(value, 'meta');
  return Reflect.get(value, Symbol.for('schemastery')) === true
    && typeof Reflect.get(value, 'type') === 'string'
    && meta !== null && typeof meta === 'object';
};

// --- 两份实现都必须同时满足「能激活」和「面板可编辑」 ---
for (const [label, schema] of [['fallback', createFallbackConfig()], ['current', Config]]) {
  assert.ok(isNativeConfigSchema(schema), `${label}: isNativeConfigSchema 必须为 true，否则设置面板显示 unsupported`);
  assert.equal(typeof schema['~standard']?.validate, 'function',
    `${label}: 必须有 ~standard.validate，否则 cordis 激活时崩在 reading 'validate'`);
  assert.equal(schema['~standard'].version, 1);
  // 面板按 dict 渲染字段，所有配置项都要在
  assert.deepEqual(Object.keys(schema.dict ?? {}).sort(), Object.keys(DEFAULT_CONFIG).sort(),
    `${label}: dict 必须覆盖全部配置项`);
  assert.equal(schema.meta.default !== undefined, true, `${label}: 对象节点要有 meta.default`);
}

// --- 兜底实现的宽松修正：写错配置不能挂死插件 ---
const fb = createFallbackConfig();
const v = (input) => fb['~standard'].validate(input).value;

assert.deepEqual(v({ triggerWords: 'a, b、c\nD' }).triggerWords, ['a', 'b', 'c', 'D'], '字符串触发词要能拆分');
assert.deepEqual(v({ triggerWords: ['  ', ''] }).triggerWords, DEFAULT_CONFIG.triggerWords, '全是空白时退回默认');
assert.equal(v({ timeoutMin: '25' }).timeoutMin, 25, '数字字符串要转成数字');
assert.equal(v({ timeoutMin: -5 }).timeoutMin, DEFAULT_CONFIG.timeoutMin, '负数退回默认');
assert.equal(v({ timeoutMin: 'bad' }).timeoutMin, DEFAULT_CONFIG.timeoutMin, '非法值退回默认');
assert.equal(v({ harkUrl: '' }).harkUrl, '', '空字符串保留（空是 harkUrl 的合法状态）');
assert.equal(v(undefined).maxChars, DEFAULT_CONFIG.maxChars, 'undefined 输入给全默认值');
assert.equal(v(null).pollMs, DEFAULT_CONFIG.pollMs, 'null 输入给全默认值');
assert.equal(v({ pollMs: 3.7 }).pollMs, 3, '小数要截断成整数');
assert.equal(v({}).harkUrl, '', '缺省项要补齐，不能只剩用户写了的那几个');

// --- 兜底实现的字段节点也要像样，面板才排得出表单 ---
assert.equal(fb.dict.timeoutMin.type, 'number');
assert.equal(fb.dict.timeoutMin.meta.min, 0);
assert.equal(fb.dict.triggerWords.type, 'array');
assert.equal(fb.dict.triggerWords.inner.type, 'string');
assert.equal(fb.dict.harkUrl.type, 'string');
assert.ok(fb.dict.harkUrl.meta.description, '字段要带描述，否则面板只有 key 名');

// --- 当前后端只应是这两种之一，且必须真的可用 ---
assert.ok(['schemastery', 'fallback'].includes(configSchemaBackend));
assert.equal(typeof Config['~standard'].validate, 'function');

console.log(`config schema tests passed (backend=${configSchemaBackend})`);
