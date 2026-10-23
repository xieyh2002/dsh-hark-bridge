/**
 * Hark 回复落盘
 *
 * 为什么需要这一层：Hark 的方案/代码审查动辄几千字，塞在工具返回值里既挤占上下文，
 * 用户也没法直接打开、搜索、贴给别人。把原文另外存成工作区里的 Markdown，
 * 模型上下文里就只剩一句「已保存到 …」，人则拿到一个可以在编辑器里读的文件。
 *
 * 只做三件事：算目录、拼文件名、原样落盘。不碰浏览器、不碰网络、不引依赖。
 */
import fs from 'node:fs';
import path from 'node:path';

/** front matter 里由本模块自己写的键，meta 里同名的键会被忽略，避免把固定字段覆盖坏 */
const RESERVED_KEYS = new Set(['id', 'mode', 'savedAt']);

/**
 * 落盘过程中的所有失败都收敛成这一个错误类型。
 * 调用方（工具层）只需要判断 `instanceof` 就能决定是「告诉模型没存成」还是「真有 bug」。
 */
export class ReplyStoreError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HarkReplyStoreError';
    if (options.code) this.code = options.code;
  }
}

/** 两位补零，负年份之类不管（时间戳只用于文件名与 front matter） */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 本地时区的 ISO 8601，例如 2026-10-22T20:49:31+08:00。
 * 为什么不用 toISOString()：那是 UTC，用户看文件里的 savedAt 会跟自己的钟差 8 小时，
 * 出问题时根本对不上「我几点点的发送」。
 * @param {Date} date
 * @returns {string}
 */
function isoLocal(date) {
  const offsetMin = -date.getTimezoneOffset(); // 东八区 = 480
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** 文件名用的本地时间戳：2026-10-22 20:49:31 → 20261022-204931 */
function stampLocal(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

/**
 * target 是否在 root 之内（含 root 本身）。
 * 用 path.relative 而不是字符串 startsWith：Windows 上 "C:\ws2" 以 "C:\ws" 开头，
 * 只看前缀会把工作区外的目录判成之内。
 */
function isInside(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // 不同盘符
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * 解析回复落盘目录。
 * @param {{ workspaceRoot: string, replyDir?: string }} opts
 * @returns {string} 绝对路径
 */
export function resolveReplyDir(opts = {}) {
  const rawRoot = typeof opts.workspaceRoot === 'string' ? opts.workspaceRoot : '';
  if (!rawRoot.trim()) {
    throw new ReplyStoreError('resolveReplyDir 需要 workspaceRoot：没有工作区就没有地方放回复文件');
  }
  const root = path.resolve(rawRoot);

  const rawDir = typeof opts.replyDir === 'string' ? opts.replyDir : '';
  if (!rawDir.trim()) return path.join(root, '.hark', 'replies');

  // path.resolve 遇到绝对路径会直接采用它，正好把「绝对原样 / 相对拼 root」两种情况合一。
  const target = path.resolve(root, rawDir);
  if (!isInside(root, target)) {
    throw new ReplyStoreError(`replyDir 必须位于工作区内：${target} 不在 ${root} 之内`);
  }
  return target;
}

/**
 * 值能否裸写进 YAML。
 * 不追求完整 YAML 规范，只要「我们写出去的能被常规解析器读回来」：
 * 含冒号（题面要求）、换行、会引发注释/流式语法的字符，以及看起来像数字/布尔的字符串，
 * 一律加双引号，宁可多引号也不要让 harkUrl 之类的值被解析歪。
 */
function needsQuote(text) {
  if (text !== text.trim()) return true; // 首尾空白裸写会被吃掉
  if (/[:#\n\r\t"]/.test(text)) return true;
  if (/^[-?:,\[\]{}&*!|>'"%@`]/.test(text)) return true;
  if (/^(?:true|false|null|~|[-+]?\d+(?:\.\d+)?)$/i.test(text)) return true;
  return false;
}

/** 双引号串里必须转义的字符（YAML 不允许裸换行） */
function quoteYaml(text) {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/**
 * 最小 YAML 标量序列化。返回空字符串表示「这个键没有值，别写」。
 * @param {unknown} value
 * @returns {string}
 */
function yamlScalar(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    const parts = value
      .filter((v) => v !== undefined && v !== null)
      .map((v) => String(v).trim())
      .filter((s) => s !== '');
    return parts.length ? yamlScalar(parts.join(', ')) : '';
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : yamlScalar(isoLocal(value));
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return String(value);

  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (!text) return '';
  return needsQuote(text) ? quoteYaml(text) : text;
}

/** 键名能不能裸写；含冒号/换行的键会把 front matter 结构写坏，直接丢掉这个键 */
function safeKey(key) {
  const k = String(key).trim();
  if (!k) return '';
  if (/[:#\n\r\t]/.test(k)) return '';
  if (/^[-?:,\[\]{}&*!|>'"%@`]/.test(k)) return '';
  return k;
}

/**
 * front matter。字段顺序是固定的：id、mode 在前（人眼第一眼要知道「这是哪次、什么模式」），
 * 然后按 meta 的插入顺序（调用方给的顺序通常就是它想展示的顺序），savedAt 收尾。
 */
function buildFrontMatter({ id, mode, meta, savedAt }) {
  const lines = ['---', `id: ${yamlScalar(id)}`, `mode: ${yamlScalar(mode)}`];

  for (const [key, value] of Object.entries(meta)) {
    if (RESERVED_KEYS.has(key)) continue;
    const name = safeKey(key);
    if (!name) continue;
    const scalar = yamlScalar(value);
    if (scalar === '') continue; // undefined / null / 空串 / 空数组
    lines.push(`${name}: ${scalar}`);
  }

  // savedAt 自己生成的、格式已知且裸写合法，不走 needsQuote（否则会带上讨厌的引号）
  lines.push(`savedAt: ${savedAt}`, '---');
  return lines.join('\n');
}

/** 文件名片段清洗：id/mode 来自外部，不能让它带出路径分隔符或 Windows 非法字符 */
function safePart(text) {
  const cleaned = String(text)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 80);
  return cleaned || '_';
}

/** 文件名里最多放这么多个字符的标题，太长会盖住时间戳、也不好复制 */
const TITLE_MAX = 60;

/**
 * 从回复正文里挑一个能当文件名的标题。
 *
 * 为什么值得这么做：文件名里带 `cyqfufir4` 这种请求编号，除了插件自己没人看得懂。
 * 用户要在资源管理器里找「上次那份改进方案」，只能一个个打开。正文第一个标题
 * 本来就是这份文档的名字，直接拿来用，文件名自己就说明了内容。
 *
 * 取第一个 ATX 标题（`# 方案` / `## 审查意见`）。没有标题就返回空串，
 * 由调用方退回请求编号——宁可名字难看，也不要凭空编一个和内容不符的。
 * @param {string} text
 * @returns {string}
 */
export function titleOf(text) {
  if (typeof text !== 'string' || !text) return '';
  // 只看前 40 行：标题总在开头，往后找会把正文里的小标题误当成文档名。
  const head = text.split('\n', 40);
  for (const line of head) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const title = stripMarkdown(m[1]);
    if (title) return title;
  }
  return '';
}

/** 去掉标题里的 Markdown 装饰，剩下的才是人想看到的字 */
function stripMarkdown(text) {
  return String(text)
    // 链接 [文字](url) → 文字；图片同理
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 行内代码、加粗、斜体、删除线
    .replace(/[`*_~]/g, '')
    // 标题里几乎不会有尖括号，但 HTML 标签要剥掉
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把标题变成文件名片段。
 *
 * 中文原样保留——转拼音或英文只会让人更看不懂。空格和连续标点压成一个 `-`，
 * 让 `dsh-hark-bridge 0.8 改进方案` 变成 `dsh-hark-bridge-0.8-改进方案`。
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  const raw = stripMarkdown(text);
  if (!raw) return '';
  const slug = raw
    // 只留中英文、数字、点和横线；其余（括号、冒号、顿号…）都当分隔符
    .replace(/[^\p{Script=Han}\p{L}\p{N}.-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, TITLE_MAX)
    .replace(/[-.]+$/, '');
  return slug;
}

/**
 * 算一个既能排序、又能看懂的基名。
 *
 * 形状：`20261023-103834-review-dsh-hark-bridge-0.8-改进方案`
 * —— 时间戳在前（目录按名字排就是时间序），模式居中，标题收尾。
 * 拿不到标题时退回请求编号，至少还能和 Hark 页面对上。
 * @param {{ now: Date, mode: string, id: string, title?: string }} p
 * @returns {string}
 */
export function baseNameOf({ now, mode, id, title }) {
  const slug = slugify(title || '');
  const tail = slug || safePart(id);
  return `${stampLocal(now)}-${safePart(mode)}-${safePart(tail)}`;
}

/**
 * 给 Hark 下载下来的附件算一个规范文件名。
 *
 * 卡片名（`dsh-hark-bridge-0.8-改进方案.md`）本身就是 Hark 给这份文档起的名字，
 * 比请求编号有用得多，所以优先用它；卡片名拿不到（只有个 `button`）才退回正文标题。
 * 两种都拿不到时返回空串，让调用方保留下载时的临时名。
 * @param {{ name?: string, text?: string, mode?: string, now?: Date }} p
 * @returns {string} 形如 `20261023-120733-plan-dsh-hark-bridge-0.8-改进方案.md`
 */
export function downloadNameOf(p = {}) {
  const now = p.now instanceof Date ? p.now : new Date();
  // 卡片名带 .md 后缀，先剥掉：slugify 会把点当合法字符留下，拼出来就是 `xxx.md.md`
  const fromCard = String(p.name || '').replace(/\.(?:md|markdown)$/i, '');
  const title = fromCard || titleOf(p.text || '');
  const slug = slugify(title);
  if (!slug) return '';
  const mode = safePart(p.mode || 'hark');
  return `${stampLocal(now)}-${mode}-${safePart(slug)}.md`;
}

/**
 * 把下载下来的附件改成规范文件名（同目录改名）。
 *
 * 为什么不在下载时直接给最终名：卡片名要等脚本点开卡片、拿到 `aria-label` 才知道，
 * 而 `page.fetch(saveAs)` 需要一个确定的路径，那时还叫 `<id>.hark.md`。
 * 所以先下到临时名，拿到卡片名后再 rename——同一目录内 rename 是原子的，
 * 中途崩了最多留一个临时名文件，不会出现半份内容。
 *
 * 拿不到能用的名字时原样返回（宁可名字难看，也不要丢文件）。
 * @param {{ saved: string, name?: string, text?: string, mode?: string, now?: Date }} p
 * @returns {{ saved: string, name: string }}
 */
export function renameDownloaded(p = {}) {
  const saved = typeof p.saved === 'string' ? p.saved : '';
  if (!saved) return { saved, name: String(p.name || '') };

  // 调用方不一定把正文传进来（下载脚本可能只回了文件名），这时自己读一遍——
  // 改名这件事值得多花一次读盘，总比留个 `<id>.hark.md` 强。
  let text = typeof p.text === 'string' ? p.text : '';
  if (!text && !p.name) {
    try { text = fs.readFileSync(saved, 'utf8'); } catch { /* 读不到就当没有标题 */ }
  }

  const name = downloadNameOf({ ...p, text });
  if (!name) return { saved, name: String(p.name || '') };

  const dir = path.dirname(saved);
  const current = path.basename(saved);
  if (current === name) return { saved, name };

  // 同一秒、同一标题的两次下载会撞名。挑一个没被占用的，别覆盖别人的文件。
  let target = path.join(dir, name);
  for (let n = 2; fs.existsSync(target) && n <= 999; n += 1) {
    target = path.join(dir, `${name.replace(/\.md$/i, '')}-${n}.md`);
  }
  fs.renameSync(saved, target);
  return { saved: target, name: path.basename(target) };
}

/** 临时文件后缀，避免多个进程/并发写撞同一个 tmp */
function tmpSuffix() {
  return `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 挑一个没被占用的文件名。同一秒同一 id 重复保存（重试、用户连点）时会落到 -2、-3……
 * 为什么不用「已存在就覆盖」：那是别人可能正在读的文件，覆盖等于悄悄删数据。
 */
function pickName(dir, base) {
  for (let n = 1; n <= 9999; n += 1) {
    const name = n === 1 ? `${base}.md` : `${base}-${n}.md`;
    if (!fs.existsSync(path.join(dir, name))) return name;
  }
  throw new ReplyStoreError(`同一秒内同名回复过多，无法为 ${base} 找到可用文件名`);
}

/**
 * 保存一条回复。
 * @param {object} p
 * @param {string} p.dir  resolveReplyDir 的返回值
 * @param {string} p.id   请求编号（如 'j5y4sxaye'）
 * @param {string} p.mode 'plan' | 'review' | 'chat'
 * @param {string} p.reply 回复正文
 * @param {string} [p.title] 文件名用的标题；不给就从 reply 的第一个标题里取
 * @param {object} [p.meta] 额外写进 front matter 的键值
 * @param {Date}   [p.now]
 * @returns {{ abs: string, rel: string }}
 */
export function saveReply(p = {}) {
  const rawDir = typeof p.dir === 'string' ? p.dir : '';
  if (!rawDir.trim()) {
    throw new ReplyStoreError('saveReply 需要 dir：先用 resolveReplyDir 解析落盘目录');
  }
  const id = typeof p.id === 'string' ? p.id.trim() : '';
  if (!id) throw new ReplyStoreError('saveReply 需要非空的 id（Hark 请求编号）');
  const mode = typeof p.mode === 'string' ? p.mode.trim() : '';
  if (!mode) throw new ReplyStoreError('saveReply 需要非空的 mode（plan/review/chat）');

  // reply 为 undefined/null 时当成空回复：Hark 偶尔回空，落一个只有 front matter 的文件
  // 也好过让调用方在这里抛错、把整次请求判失败。
  let reply;
  if (typeof p.reply === 'string') reply = p.reply;
  else if (p.reply === undefined || p.reply === null) reply = '';
  else reply = String(p.reply);

  const now = p.now instanceof Date ? p.now : p.now === undefined || p.now === null ? new Date() : new Date(p.now);
  if (Number.isNaN(now.getTime())) throw new ReplyStoreError('saveReply 的 now 不是合法时间');

  const meta = p.meta && typeof p.meta === 'object' && !Array.isArray(p.meta) ? p.meta : {};
  const savedAt = isoLocal(now);
  const front = buildFrontMatter({ id, mode, meta, savedAt });

  // 只补一个换行，不 trim 尾部：Markdown 的尾随空行有时是刻意的（列表、代码块收尾）
  const body = reply.endsWith('\n') ? reply : `${reply}\n`;
  const content = `${front}\n\n${body}`;
  const bytes = Buffer.byteLength(content, 'utf8');

  const dir = path.resolve(rawDir);
  // 文件名主体优先用正文标题（人一眼能看懂），拿不到才退回请求编号。
  const title = typeof p.title === 'string' && p.title.trim() ? p.title : titleOf(reply);
  const base = baseNameOf({ now, mode, id, title });
  let tmpAbs = '';
  try {
    fs.mkdirSync(dir, { recursive: true });

    // tmp 名带上 base 但不占用目标名，内容只写一次，之后无论挑到哪个序号都是同一份字节
    tmpAbs = path.join(dir, `.${base}.tmp${tmpSuffix()}`);
    fs.writeFileSync(tmpAbs, content, 'utf8');

    let name = pickName(dir, base);
    let abs = path.join(dir, name);
    // 挑名到 rename 之间目标理论上可能被别的进程抢建（Windows 的 rename 会直接覆盖），
    // 所以再确认一次；真撞了就退到下一个序号。
    for (let retry = 0; retry < 5 && fs.existsSync(abs); retry += 1) {
      name = pickName(dir, base);
      abs = path.join(dir, name);
    }
    fs.renameSync(tmpAbs, abs);
    tmpAbs = '';

    const written = fs.statSync(abs).size;
    if (written !== bytes) {
      try { fs.unlinkSync(abs); } catch { /* 尽力清理，清理失败不掩盖真正的错误 */ }
      throw new ReplyStoreError(`写入不完整：期望 ${bytes} 字节，实际 ${written} 字节（${abs}）`);
    }

    return { abs, rel: name.split(path.sep).join('/') };
  } catch (err) {
    if (tmpAbs) {
      try { fs.unlinkSync(tmpAbs); } catch { /* tmp 可能根本没创建成功 */ }
    }
    if (err instanceof ReplyStoreError) throw err;
    throw new ReplyStoreError(
      `保存回复失败（${dir}）：${err && err.message ? err.message : String(err)}`,
      { code: err && err.code, cause: err },
    );
  }
}
