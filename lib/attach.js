/**
 * 附件校验与暂存
 *
 * 为什么单独成一层：ask_hark 允许模型传任意路径，等于开了一条「把本机任意文件发到第三方」的通道。
 * 边界判断、软链逃逸、敏感文件这类安全逻辑一旦混进浏览器脚本里，就只能在真实页面上碰运气验证；
 * 抽成纯 Node 模块之后，它可以被穷举测试，也不用启动浏览器。
 *
 * 这一层只做四件事，彼此可独立调用：
 *   checkAttachment    单文件校验（不复制，只算 sha256）
 *   collectAttachments 批量校验 + 去重 + 总量限制（坏路径降级为 skipped，不中断整批）
 *   stageAttachments   复制到暂存目录，扁平化重名，复制后复核 sha256
 *   cleanupStaging     整目录删除
 *
 * 与旧版的取舍：旧版把「校验 + 复制 + 生成清单」挤在一个函数里，调用方没法在复制前先看清单，
 * 也没法在浏览器侧失败时只清暂存而不重跑校验。拆开之后每一段都能单独测。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 调用方只需要区分「附件准备失败」，不必解析底层 errno */
export class AttachError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HarkAttachError';
  }
}

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20;

/** Windows / macOS 默认大小写不敏感：边界比较与重名判断都得跟着放宽，否则 c:\work 与 C:\work 会被当成两个目录 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * 敏感文件规则表。
 *
 * 存在理由：这些文件一旦被上传，就等于把凭据贴进网页对话历史，撤回不了；
 * `.git` / `node_modules` 则是噪声炸弹，一次「传几个附件」会变成上传上万个文件。
 * 每条规则都带人类可读的名字，报错时直接告诉模型「你踩的是哪条」，比笼统的「不允许」好调试得多。
 */
const DENY_RULES = [
  {
    name: '环境变量文件',
    match: (ctx) => ctx.base === '.env' || ctx.base.startsWith('.env.'),
  },
  {
    name: '私钥或证书文件',
    match: (ctx) => ['.pem', '.key', '.pfx', '.p12', '.keystore'].includes(ctx.ext),
  },
  {
    name: '私钥',
    match: (ctx) => /^id_(rsa|ed25519|ecdsa)/.test(ctx.base),
  },
  {
    name: 'git 内部文件',
    // 规范化路径前补一个 `/`，这样根目录下的 `.git/config` 与嵌套的 `sub/.git/config` 都能命中
    match: (ctx) => ctx.prefixed.includes('/.git/') || ctx.prefixed.endsWith('/.git'),
  },
  {
    name: '依赖目录',
    match: (ctx) => ctx.prefixed.includes('/node_modules/'),
  },
  {
    // 本插件自己的密钥文件，放在工作区里时最容易被顺手传出去
    name: '插件设置文件',
    match: (ctx) => ctx.base === 'settings.json',
  },
];

function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

/**
 * 边界比较必须带分隔符。
 * 只用 startsWith 的话，工作区 `C:\work` 会把同级的 `C:\work-other\x` 当成自己人——
 * 这是一类真实存在、靠肉眼 review 又极难发现的越权。
 */
function isInsideRoot(root, target) {
  const normRoot = CASE_INSENSITIVE_FS ? root.toLowerCase() : root;
  const normTarget = CASE_INSENSITIVE_FS ? target.toLowerCase() : target;
  if (normTarget === normRoot) return true;
  const prefix = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
  return normTarget.startsWith(prefix);
}

function showRel(root, abs) {
  const rel = path.relative(root, abs);
  return rel ? toPosix(rel) : path.posix.basename(toPosix(abs));
}

function normalizeLimit(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new AttachError(`${name} 必须是非负数字，收到 ${String(value)}`);
  }
  return n;
}

function resolveRoot(opts) {
  const raw = opts && typeof opts.workspaceRoot === 'string' ? opts.workspaceRoot.trim() : '';
  if (!raw) throw new AttachError('缺少 workspaceRoot（工作区根目录的绝对路径）');
  let root;
  try {
    root = fs.realpathSync(raw);
  } catch {
    throw new AttachError(`工作区目录不存在：${raw}`);
  }
  let stat;
  try {
    stat = fs.statSync(root);
  } catch (err) {
    throw new AttachError(`工作区目录无法访问：${raw}（${describeError(err)}）`);
  }
  if (!stat.isDirectory()) throw new AttachError(`workspaceRoot 不是目录：${raw}`);
  return root;
}

function describeError(err) {
  if (!err) return 'unknown';
  return err.message || err.code || String(err);
}

/** 返回命中的规则名，未命中返回 null。规则名会直接出现在报错里，所以要具体 */
function denyRuleName(rel) {
  const lower = rel.toLowerCase();
  const ctx = {
    rel: lower,
    prefixed: `/${lower}`,
    base: path.posix.basename(lower),
    ext: path.posix.extname(lower),
  };
  const hit = DENY_RULES.find((rule) => rule.match(ctx));
  return hit ? hit.name : null;
}

/**
 * 分块喂给 hash，而不是 readFileSync 整个读进来。
 * checkAttachment 是同步契约（调用方在浏览器脚本里同步取值），没法 await 一个 ReadStream，
 * 所以用 readSync 按 64 KB 推进；内存占用与文件大小无关，效果等同于流式。
 */
function sha256Of(abs) {
  const hash = createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * 把一个候选附件校验成可上传项。不复制文件，只做校验 + 算 sha256。
 *
 * 校验顺序是刻意排的，报错顺序决定模型的调试体验：
 *   1 类型      —— 先说人话，别让 undefined 变成 ENOENT
 *   2 realpath  —— 必须在 resolve 之后：符号链接的真实目标只有 realpath 知道
 *   3 边界      —— 对 realpath 的结果判断。工作区里一个指向外面的软链词法上完全合法，
 *                  只有解析之后才暴露；反过来，用个链接别名访问工作区内部也不该被误伤
 *   4 存在性    —— realpath 已经过了说明存在，只有失败时才知道是不存在还是别的毛病
 *   5 普通文件 / 大小 / 黑名单 —— 从便宜到贵，最后才算 hash
 *
 * 越界判定同时加一道词法兜底：路径不存在时没有 realpath 可看，
 * 此时若字面已经在工作区外，报「越界」比报「不存在」更贴近真实原因，也不会泄露目录结构。
 *
 * @param {string} absOrRel 用户/模型给的路径（绝对或相对 workspaceRoot）
 * @param {{workspaceRoot: string, maxFileBytes?: number}} opts
 * @returns {{rel: string, abs: string, bytes: number, sha256: string}}
 */
export function checkAttachment(absOrRel, opts) {
  if (typeof absOrRel !== 'string' || absOrRel.trim() === '') {
    throw new AttachError('路径必须是字符串');
  }
  const root = resolveRoot(opts);
  const maxFileBytes = normalizeLimit(opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'maxFileBytes');
  const raw = absOrRel.trim();

  const lexical = path.resolve(root, raw);

  let real;
  try {
    real = fs.realpathSync(lexical);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      if (!isInsideRoot(root, lexical)) {
        throw new AttachError(`路径不在工作区内：${raw}（只能发送 ${root} 下的文件）`);
      }
      throw new AttachError(`文件不存在：${showRel(root, lexical)}`);
    }
    throw new AttachError(`路径无法解析：${raw}（${describeError(err)}）`);
  }

  if (!isInsideRoot(root, real)) {
    throw new AttachError(`路径不在工作区内：${raw}（只能发送 ${root} 下的文件）`);
  }

  const rel = showRel(root, real);

  let stat;
  try {
    stat = fs.statSync(real);
  } catch (err) {
    throw new AttachError(`文件无法访问：${rel}（${describeError(err)}）`);
  }
  if (!stat.isFile()) throw new AttachError(`不是普通文件：${rel}`);

  if (stat.size > maxFileBytes) {
    // 原始字节数照写，不格式化：「超过 2 MB」和「超过 2097152」的排查体验差一个数量级
    throw new AttachError(`文件 ${rel} 有 ${stat.size} 字节，超过单文件上限 ${maxFileBytes}`);
  }

  const rule = denyRuleName(rel);
  if (rule) {
    throw new AttachError(`拒绝发送 ${rel}：命中敏感文件规则（${rule}）`);
  }

  return { rel, abs: real, bytes: stat.size, sha256: sha256Of(real) };
}

/**
 * 批量校验。单文件失败不抛错，只进 skipped——一次传十个文件时，一个笔误不该让另外九个白传。
 * 但如果原本给了路径却一个都没能通过，那就是调用方的整体错误（路径全错、工作区没对），必须抛出来，
 * 否则上层会以为「附件都传了」，把一份没有附件的请求发给 Hark。
 *
 * 限制的先后顺序：数量 → 单文件（在 checkAttachment 内）→ 总量。
 * 数量先判，是因为超数量时报「第几个开始没塞进去」比报「总量超了」更好懂。
 *
 * @param {string[]} paths
 * @param {{workspaceRoot: string, maxFileBytes?: number, maxTotalBytes?: number, maxFiles?: number}} opts
 * @returns {{items: Array, totalBytes: number, skipped: Array<{path: string, reason: string}>}}
 */
export function collectAttachments(paths, opts) {
  const list = paths === undefined || paths === null ? [] : paths;
  if (!Array.isArray(list)) {
    throw new AttachError(`paths 必须是字符串数组，收到 ${Object.prototype.toString.call(list)}`);
  }
  const maxFiles = normalizeLimit(opts && opts.maxFiles, DEFAULT_MAX_FILES, 'maxFiles');
  const maxTotalBytes = normalizeLimit(opts && opts.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 'maxTotalBytes');

  const items = [];
  const skipped = [];
  /** key → 首次出现的 rel；用于把「同一文件写了两次」变成一条可读的 skipped */
  const seen = new Map();
  let totalBytes = 0;

  for (const candidate of list) {
    let item;
    try {
      item = checkAttachment(candidate, opts);
    } catch (err) {
      if (!(err instanceof AttachError)) throw err;
      skipped.push({ path: candidate, reason: err.message });
      continue;
    }

    // 去重按 realpath：相对路径和绝对路径写同一个文件时 rel 相同，但同一文件也可能有两个 rel（软链），
    // 所以比较 abs 而不是 rel
    const key = CASE_INSENSITIVE_FS ? item.abs.toLowerCase() : item.abs;
    const first = seen.get(key);
    if (first !== undefined) {
      skipped.push({ path: candidate, reason: `重复：与 ${first} 是同一个文件` });
      continue;
    }

    if (items.length >= maxFiles) {
      skipped.push({ path: candidate, reason: `超过文件数量上限（最多 ${maxFiles} 个）` });
      continue;
    }

    const nextTotal = totalBytes + item.bytes;
    if (nextTotal > maxTotalBytes) {
      // 不中断后续项：后面的小文件可能还塞得进去
      skipped.push({
        path: candidate,
        reason: `加入后总量 ${nextTotal} 字节，超过总量上限 ${maxTotalBytes} 字节（当前 ${totalBytes} 字节）`,
      });
      continue;
    }

    seen.set(key, item.rel);
    items.push(item);
    totalBytes = nextTotal;
  }

  if (items.length === 0 && list.length > 0) {
    const detail = skipped.map((s) => `- ${String(s.path)}：${s.reason}`).join('\n');
    throw new AttachError(`没有任何附件可用，全部被拒绝：\n${detail}`);
  }

  return { items, totalBytes, skipped };
}

/**
 * 扁平化成上传名：`lib/bridge.js` → `lib__bridge.js`。
 *
 * 为什么要扁平：网页版 Hark 的 file input 只接受文件名，目录层级在那一侧不存在；
 * 用 `__` 而不是 `_` 表示层级，是为了让 `a/b.js`（`a__b.js`）与 `a b.js`（`a b.js`）不撞车——
 * 空格在真实项目里很常见，两者压成同一个名字会静默丢文件。
 */
function flattenName(rel) {
  let name = String(rel ?? '');
  // 目录分隔符先整体替换成 `__`（保留层级信息）；Windows 的反斜杠也一并算分隔符
  name = name.replace(/[\\/]+/g, '__');
  // 其余在 Windows 上非法或危险的字符：保留字符 + 控制字符
  name = name.replace(/[\u0000-\u001f<>:"|?*]/g, '_');
  // Windows 会悄悄吃掉结尾的空格和点（"a.txt " 落盘变成 "a.txt"），
  // 不先裁掉的话，暂存名与实际文件名会对不上，后面的 sha256 复核就会「找不到文件」
  name = name.replace(/[ .]+$/, '');
  return name || 'file';
}

/**
 * 加 -2、-3 后缀，并且加在扩展名之前（`a.md` → `a-2.md`，不是 `a.md-2`），
 * 否则 Hark 那边看到的文件名会让人以为扩展名是 `.md-2`。
 * 大小写不敏感地判重，避免 `A.md` 与 `a.md` 在 Windows 上互相覆盖。
 */
function uniqueName(base, used) {
  const key = (name) => (CASE_INSENSITIVE_FS ? name.toLowerCase() : name);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let name = base;
  let n = 2;
  while (used.has(key(name))) {
    name = `${stem}-${n}${ext}`;
    n += 1;
  }
  used.add(key(name));
  return name;
}

/**
 * 把已校验的附件复制到 staging 目录。
 *
 * 为什么复制而不是直接传原路径：一次 ask 从发起、上传到 Hark 回复可能跨几分钟，
 * 期间工作区里的文件完全可能被别的代理改掉；先钉一份快照，再带着 sha256 复核，
 * 才能保证「Hark 看到的」与「我们以为发出去的」是同一份内容。
 *
 * @param {Array} items collectAttachments 的 items
 * @param {string} stagingDir 绝对路径（不存在会自动创建）
 * @returns {Array} 每项在原有字段上加 staged（绝对路径）与 uploadName
 */
export function stageAttachments(items, stagingDir) {
  const list = items === undefined || items === null ? [] : items;
  if (!Array.isArray(list)) {
    throw new AttachError(`items 必须是数组，收到 ${Object.prototype.toString.call(list)}`);
  }
  if (list.length === 0) return [];

  const dir = typeof stagingDir === 'string' ? stagingDir.trim() : '';
  if (!dir) throw new AttachError('缺少 stagingDir（附件暂存目录的绝对路径）');

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new AttachError(`暂存目录无法创建：${dir}（${describeError(err)}）`);
  }

  const used = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || typeof item.abs !== 'string') {
      throw new AttachError('items 里的每一项都必须是 checkAttachment 的返回值');
    }
    const rel = String(item.rel ?? path.basename(item.abs));
    const uploadName = uniqueName(flattenName(rel), used);
    const staged = path.join(dir, uploadName);

    try {
      fs.copyFileSync(item.abs, staged);
    } catch (err) {
      throw new AttachError(`暂存附件失败：${rel}（${describeError(err)}）`);
    }

    const expected = Number(item.bytes);
    if (Number.isFinite(expected)) {
      const copied = fs.statSync(staged).size;
      if (copied !== expected) {
        throw new AttachError(`附件复制不完整：${rel}（原 ${expected} 字节，暂存 ${copied} 字节）`);
      }
    }

    // 复核而不只信 copyFileSync 的长度：磁盘满、并发替换、杀毒软件改写都会给出等长但内容不同
    if (typeof item.sha256 === 'string' && item.sha256) {
      const actual = sha256Of(staged);
      if (actual !== item.sha256) {
        throw new AttachError(
          `附件校验失败：${rel} 复制后的 sha256 与源文件不一致（源 ${item.sha256}，暂存 ${actual}）`,
        );
      }
    }

    out.push({ ...item, rel, staged, uploadName });
  }
  return out;
}

/**
 * 删除 staging 目录（不存在也不报错）。
 *
 * 不往外抛异常：它几乎总是被放在 finally 里调用，此时如果清理失败再抛一次，
 * 会把真正的失败原因（上传失败、超时）盖掉，用户只能看到「删文件失败」这种无关信息。
 */
export function cleanupStaging(stagingDir) {
  const dir = typeof stagingDir === 'string' ? stagingDir.trim() : '';
  if (!dir) return;
  const resolved = path.resolve(dir);
  // 护栏：暂存目录本该是一个随机生成的临时目录。传进来盘根或当前工作目录时宁可不删，
  // 否则一次参数写错就会把整个工作区递归删掉。
  if (resolved === path.parse(resolved).root) return;
  if (resolved === path.resolve(process.cwd())) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    // 保留给调用方：文件可能正被浏览器占用（Windows 上 EBUSY 很常见）
  }
}
