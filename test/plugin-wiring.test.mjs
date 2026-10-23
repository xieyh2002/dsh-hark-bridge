import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import 插件前设好：/hark-url 会写用户级覆盖层，
// 不隔离的话测试会改到用户真实的 Hark 地址。
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-wiring-'));
process.env.DSH_HARK_BRIDGE_HOME = sandbox;

const { name, inject, apply, buildToolDescription, composeBody, describeUrl } = await import('../lib/index.js');
const { readOverride, storePath, normalizeUrl } = await import('../lib/store.js');

// inject 必须是「服务名数组」。写成 { required: [...] } 对象会被 cordis
// 当成 name->config 映射，服务名变成字符串 "required"，插件永远 PENDING。
assert.equal(name, 'hark-bridge');
assert.ok(Array.isArray(inject), 'inject 必须是数组');
assert.deepEqual(inject, ['tools']);

const desc = buildToolDescription(['问 Hark', '@hark']);
assert.ok(desc.includes('「问 Hark」') && desc.includes('必须先分析'));
// 触发词清空时不能留出「出现  等字样」这种空槽
assert.ok(!buildToolDescription([]).includes('等字样'));
assert.ok(!buildToolDescription(['  ']).includes('等字样'));

const body = composeBody({ user_request: '加导出', analysis: '目标：导出 CSV', context: '', questions: '用什么库？' });
assert.ok(body.startsWith('## 用户原话\n加导出'));
assert.ok(body.includes('## DSH 的分析') && body.includes('## 需要 Hark 决定的问题') && !body.includes('项目上下文'));
// 非字符串参数不能被 String() 成 "[object Object]" 塞进正文
assert.ok(!composeBody({ user_request: 'x', analysis: { a: 1 } }).includes('object Object'));

// --- 宿主提供 commands：工具和两条命令都注册 ---
const tools = [], commands = [];
const ctxWith = {
  effect: (fn) => fn(),
  get: (n) => (n === 'commands' ? { register: (c) => { commands.push(c); return () => {}; } } : undefined),
  tools: { register: (t) => { tools.push(t); return () => {}; } },
};
apply(ctxWith, {});
assert.equal(tools.length, 1);
assert.equal(tools[0].name, 'ask_hark');
assert.ok(tools[0].description.includes('「交给 Hark」'));
// parameters 必须是合法 JSON Schema：顶层 type:'object'，必填项在 required 数组里。
// 这里守住降级路径——import('@deepseek-ai/dsh-tools') 失败时 defineTool 自己转，
// 转错了模型看到的参数定义就是错的，而且只在没人盯着的场景发生。
assert.equal(tools[0].parameters.type, 'object', 'parameters 必须声明 type: object');
assert.ok(Array.isArray(tools[0].parameters.required), 'required 必须是数组');
assert.ok(tools[0].parameters.required.includes('analysis'), 'analysis 必须是必填');
assert.ok(tools[0].parameters.required.includes('mode'), 'mode 必须是必填');
assert.ok(!tools[0].parameters.required.includes('context'), 'context 是可选参数');
assert.equal(tools[0].parameters.properties.analysis.type, 'string');
assert.equal(tools[0].parameters.properties.attachments.type, 'array');
assert.equal(tools[0].parameters.properties.attachments.items.type, 'string');
assert.ok(!('required' in tools[0].parameters.properties.analysis), 'DSL 的 required 不能残留到字段上');
assert.deepEqual(commands.map((c) => c.name).sort(), ['hark', 'hark-diag', 'hark-login', 'hark-url']);

// --- 宿主没有 commands：不能抛错，工具照旧可用 ---
const tools2 = [];
apply({
  effect: (fn) => fn(),
  get: () => undefined,
  tools: { register: (t) => { tools2.push(t); return () => {}; } },
}, {});
assert.deepEqual(tools2.map((t) => t.name), ['ask_hark'], 'commands 缺失时不能拖垮整个插件');

// 空输入
const r = await commands.find((c) => c.name === 'hark').handler({ rawInput: '   ' });
assert.equal(r.kind, 'error');

// analysis 为空 → 明确拒绝
await assert.rejects(() => tools[0].execute({ mode: 'plan', user_request: 'x', analysis: ' ' }, {}), /analysis/);
// mode 非法 → 明确拒绝
await assert.rejects(() => tools[0].execute({ mode: 'nope', user_request: 'x', analysis: '分析' }, {}), /mode/);
// 没设置地址时给出明确错误，并直接告诉用户用哪条命令
await assert.rejects(
  () => tools[0].execute({ mode: 'chat', user_request: 'hi', analysis: '打招呼' }, {}),
  /hark-url/,
);

// --- /hark-url ---
const urlCmd = commands.find((c) => c.name === 'hark-url');
// 不带参数：说明当前状态与用法
const blank = await urlCmd.handler({ rawInput: '' });
assert.equal(blank.kind, 'success');
assert.ok(blank.text.includes('还没有设置'), '未设置时应提示尚未设置');
assert.ok(blank.text.includes('/hark-url'), '应给出用法');
assert.ok(blank.text.includes(storePath()), '应告诉用户配置文件在哪');

// 非法输入逐个拒绝，且不写盘
for (const bad of ['不是网址', 'ftp://x.com/a', 'javascript:alert(1)']) {
  const r = await urlCmd.handler({ rawInput: bad });
  assert.equal(r.kind, 'error', `${bad} 应被拒绝`);
  assert.deepEqual(readOverride(), {}, `拒绝 ${bad} 后不应留下任何写入`);
}
// 缺协议头也算非法（避免拼出 file 路径或相对地址）
assert.equal((await urlCmd.handler({ rawInput: 'hark.example.com/chat' })).kind, 'error');

// 合法地址写入并立刻生效
const ok = await urlCmd.handler({ rawInput: 'https://hark.example.com/chat/abc' });
assert.equal(ok.kind, 'success');
assert.equal(readOverride().harkUrl, 'https://hark.example.com/chat/abc');
const saved = await urlCmd.handler({ rawInput: '' });
assert.ok(saved.text.includes('https://hark.example.com/chat/abc'));
assert.ok(saved.text.includes('由 /hark-url 设置'), '应说明值来自命令而非 cordis 配置');
assert.ok(describeUrl('').includes('还没有设置'));

// 覆盖层优先级高于 cordis config
const tools3 = [], commands3 = [];
apply({
  effect: (fn) => fn(),
  get: (n) => (n === 'commands' ? { register: (c) => { commands3.push(c); return () => {}; } } : undefined),
  tools: { register: (t) => { tools3.push(t); return () => {}; } },
}, { harkUrl: 'https://from-cordis.example.com/x' });
// 不真的联网：只确认读取链路拿到的是覆盖层的值
assert.ok(describeUrl('https://from-cordis.example.com/x').includes('由 /hark-url 设置'),
  '存了覆盖值后，即使是 cordis 传进来的地址也应标记为命令来源');

// 空字符串等价于删除覆盖
await urlCmd.handler({ rawInput: 'https://hark.example.com/chat/abc' });
const { writeOverride } = await import('../lib/store.js');
writeOverride({ harkUrl: '' });
assert.deepEqual(readOverride(), {}, '空值应删除该键');
assert.equal(normalizeUrl('').ok, false);

fs.rmSync(sandbox, { recursive: true, force: true });

console.log('plugin wiring tests passed');
