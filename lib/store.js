/**
 * 配置覆盖层（harkUrl、握手记录）
 *
 * Cordis 的 config 只在 cordis.yml / cordis.patch.yml 里，改它要重启或手改 YAML。
 * 但 harkUrl 这种「装完才知道」的值，用户希望当场就能设置——所以这里再放一层
 * JSON，由 /hark-url 命令写入，读取时优先级高于 cordis config。
 *
 * 为什么要两层（工作区 / 全局）：插件的 Node 代码走原生 fs，不受 dsh-fs-sandbox
 * 约束，但部署方可能真的只给会话工作区写权限。那种环境下写 %LOCALAPPDATA% 会
 * 失败，插件就彻底没法配置了。所以：
 *   - 默认写全局（用户级偏好，换项目不用重设）；
 *   - 全局写不进去时自动落到 <工作区>/.hark/settings.json；
 *   - 读的时候工作区层优先（键级覆盖），两层合并，这样降级后立刻生效。
 *
 * 全局目录选择顺序：
 *   1. DSH_HARK_BRIDGE_HOME（测试与特殊部署用）
 *   2. %LOCALAPPDATA%\dsh-hark-bridge（Windows 常规位置）
 *   3. ~/.dsh-hark-bridge
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = 'settings.json';

/**
 * 当前会话的工作区根目录。由调用方在拿到 exec.agent 后设置——
 * 模块顶层拿不到，而每个请求的工作区可能不同（多窗口 / 多项目）。
 */
let activeRoot = '';

/** @param {string} root 工作区根目录的绝对路径；空值表示「不知道工作区」 */
export function setWorkspaceRoot(root) {
  const text = typeof root === 'string' ? root.trim() : '';
  activeRoot = text ? path.resolve(text) : '';
}

/** 全局目录（用户级） */
export function dataDir() {
  const custom = process.env.DSH_HARK_BRIDGE_HOME;
  if (custom && custom.trim()) return path.resolve(custom.trim());
  const local = process.env.LOCALAPPDATA;
  if (local && local.trim()) return path.join(local.trim(), 'dsh-hark-bridge');
  return path.join(os.homedir(), '.dsh-hark-bridge');
}

/** 工作区内的目录；不知道工作区时返回空串 */
export function workspaceDataDir() {
  return activeRoot ? path.join(activeRoot, '.hark') : '';
}

/**
 * 「当前会读的那个文件」——给用户看提示用。
 *
 * 工作区层存在就以它为准（readOverride 里它覆盖全局），否则是全局文件。
 * 注意这不代表「写一定写到这里」：写入优先全局，写不进去才降到工作区。
 */
export function storePath() {
  const local = workspaceDataDir();
  if (local) {
    const wsFile = path.join(local, FILE);
    try { fs.accessSync(wsFile, fs.constants.R_OK); return wsFile; } catch { /* 没有就报全局 */ }
  }
  return path.join(dataDir(), FILE);
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * 读覆盖值。工作区层覆盖全局层的同名键。
 * 文件不存在、内容坏掉都当「没有覆盖」，绝不让插件装不上。
 * @returns {Record<string, unknown>} 只含用户显式设过的键
 */
export function readOverride() {
  const merged = readJson(path.join(dataDir(), FILE));
  const local = workspaceDataDir();
  if (!local) return merged;
  const over = readJson(path.join(local, FILE));
  for (const [key, value] of Object.entries(over)) {
    // null 是「这一层要求删掉全局里的同名键」的占位，不是值本身。
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** 把整份对象写到指定文件；先写临时文件再 rename，写到一半断电不会留下半个 JSON */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/**
 * 写入若干键；值为 undefined/null/'' 表示删除该键。
 *
 * 目标层：默认全局。全局写不进去（只读挂载、权限不足、部署方围栏）就退回工作区，
 * 保证「至少还能配置」。删键同理——哪层能写就改哪层，另一层留下的旧值会由
 * 工作区层的同名键覆盖掉（如果删的是全局里的键而写入落在工作区层，会显式写一个
 * null 占位，readOverride 合并时剔除）。
 *
 * @param {Record<string, unknown>} patch
 * @returns {string} 实际写入的文件路径
 */
export function writeOverride(patch) {
  const apply = (base) => {
    const next = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null || value === '') delete next[key];
      else next[key] = value;
    }
    return next;
  };

  const globalFile = path.join(dataDir(), FILE);
  const globalData = readJson(globalFile);
  try {
    return writeJson(globalFile, apply(globalData));
  } catch (e) {
    const local = workspaceDataDir();
    if (!local) throw e;
    const localFile = path.join(local, FILE);
    const localData = readJson(localFile);
    const next = apply({ ...globalData, ...localData });
    // 被删掉的键如果全局层还有，就在工作区层写 null 占位，
    // 否则 readOverride 合并时又会把它从全局捞回来。
    for (const key of Object.keys(patch)) {
      const v = patch[key];
      if ((v === undefined || v === null || v === '') && key in globalData) next[key] = null;
    }
    return writeJson(localFile, next);
  }
}

/** 归一化一个 URL：必须是 http/https，末尾斜杠去掉 */
export function normalizeUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, error: '用法：/hark-url https://…（Hark 对话页面的地址，从浏览器地址栏复制）' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: `不是合法的网址：${text}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `只支持 http/https，收到 ${url.protocol}` };
  }
  return { ok: true, url: url.href };
}
