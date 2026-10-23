// 抓真实 Hark 页面的 DOM 快照，脱敏后存成夹具。
//
// 为什么需要：e2e 里的假页面是照我们对 Hark 的理解写的，Hark 改版后 CI 仍然全绿，
// 而真机上插件已经瞎了。存一份真实结构，让页面表达式在 jsdom 里针对它跑单测，
// 才能在改版后立刻红。
//
// 用法：node scripts/capture-fixture.mjs [输出文件名]
// 依赖：ego 在运行、settings.json 里有 harkUrl。
//
// 脱敏的边界（重要）：夹具要进公开仓库，所以**页面上所有的对话内容、文件名、
// 项目标识都不保留**，只留 DOM 结构和协议标记的形状。契约是「结构对了，文字不对」。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarkBridge } from '../lib/bridge.js';
import { readOverride } from '../lib/store.js';

const here = dirname(fileURLToPath(import.meta.url));

// 正文一律换成这个。放在顶层而不是文件末尾：sanitize 在顶层 await 时就被调用，
// 末尾的 const 那时还在暂时性死区里，会报 Cannot access before initialization。
const PLACEHOLDER = '正文占位';
const root = join(here, '..');
const out = join(root, 'test', 'fixtures', process.argv[2] || 'hark-conversation.html');

const cfg = { ...readOverride() };
const bridge = new HarkBridge(() => cfg, { log: { warn() {} } });

const html = await bridge.captureDom();
if (!html) {
  console.error('没抓到页面内容（ego 没运行，或 harkUrl 指向的页面没打开？）');
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
const clean = sanitize(html);
writeFileSync(out, clean, 'utf8');
console.log(`已保存 ${out}（${clean.length} 字符，${(Buffer.byteLength(clean, 'utf8') / 1024).toFixed(0)} KB）`);

/**
 * 脱敏。保留：标签、class、data-testid、role、aria-label 的**形状**、
 * 协议标记本身。换掉：所有对话正文、文件名、项目标识。
 */
function sanitize(source) {
  let text = source;

  // 内联图片（base64 占夹具一多半体积，且与结构无关）
  text = text.replace(/url\(&quot;data:image\/[^)]*\)/g, 'url(&quot;data:image/png;base64,AAAA&quot;)');
  text = text.replace(/src="data:image\/[^"]*"/g, 'src="data:image/png;base64,AAAA"');
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');

  // 项目 id / 会话 id：换成定长的假 uuid，保持「长得像 id」这个事实
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '00000000-0000-0000-0000-000000000000');

  // 请求编号：**不同编号必须映射成不同假编号**。
  //
  // 早先一律映射成 fixture1，看起来更干净，实际把「哪条回复属于哪条请求」这个
  // 关系彻底抹掉了：页面上十几次往返全变成同一对标记，`MD_CARD_EXPR` 找「带结束
  // 标记的气泡」时永远命中最早那条回复，上界（下一条请求）紧跟着落在第 2 条请求上，
  // 于是本轮之后的所有卡片都被排除，count 恒为 0 ——夹具在测一个不存在的场景。
  // 保留一一对应，才测得出真实行为。
  const idMap = new Map();
  const fakeId = (raw) => {
    if (!idMap.has(raw)) idMap.set(raw, `fixture${idMap.size + 1}`);
    return idMap.get(raw);
  };
  // 先换 [[DSH-END#...]] 再换 [DSH#...]：前者的正则不会误吃后者，但顺序写清楚更稳
  text = text.replace(/\[\[DSH-END#([a-z0-9]{6,})\]\]/gi, (m, id) => `[[DSH-END#${fakeId(id)}]]`);
  text = text.replace(/\[DSH#([a-z0-9]{6,})\]/gi, (m, id) => `[DSH#${fakeId(id)}]`);

  // 属性里可能带内容的几个：标题、替代文本、表单值、地址
  text = text.replace(/\s(title|alt|placeholder|value)="[^"]*"/gi, ' $1=""');
  text = text.replace(/\shref="https?:\/\/[^"]*"/gi, ' href="#"');

  // 文本节点：保留协议标记，其余换成占位
  text = text.replace(/>([^<]*)</g, (m, body) => (body.trim() ? `>${scrubText(body)}<` : m));

  // 卡片 aria-label 里的文件名：同名映射同名、不同名映射不同名——
  // 「多张卡片同名」这种 bug 得测得出来，全换成同一个名字就测不出了
  const seen = new Map();
  text = text.replace(/(打开|open\s+preview\s+of)\s+([^\s"<]+?\.(?:md|diff|ts|js|json|txt|yml))/gi,
    (m, verb, name) => {
      if (!seen.has(name)) seen.set(name, `fixture-${seen.size + 1}${name.slice(name.lastIndexOf('.'))}`);
      return `${verb} ${seen.get(name)}`;
    });

  return text;
}

function scrubText(body) {
  // HTML 实体先换回去再扫描，避免 `&lt;编号&gt;` 被当成标签处理
  const parts = [];
  // [[DSH-END#...]] 比 [DSH#...] 长，放前面先匹配；
  // 起始标记后面紧跟的 mode 词也要留着——`isReq` 靠它判断「这条是请求」
  const re = /\[\[DSH-END#[^\]\s]*\]\]|\[DSH#[^\]\s]*\](\s*(?:plan|review|chat)\b)?/g;
  let last = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) parts.push({ keep: false, text: body.slice(last, m.index) });
    parts.push({ keep: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push({ keep: false, text: body.slice(last) });

  return parts.map((p) => {
    if (p.keep) return p.text;
    // 保留换行：气泡正文里的行首/行尾形状是协议判定的一部分
    const breaks = (p.text.match(/\n/g) || []).length;
    return breaks ? '\n'.repeat(breaks) + PLACEHOLDER : PLACEHOLDER;
  }).join('');
}
