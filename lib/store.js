/**
 * 用户级配置覆盖层
 *
 * Cordis 的 config 只在 cordis.yml / cordis.patch.yml 里，改它要重启或手改 YAML。
 * 但 harkUrl 这种「装完才知道」的值，用户希望当场就能设置——所以这里再放一层
 * 用户目录下的 JSON，由 /hark-url 命令写入，读取时优先级高于 cordis config。
 *
 * 目录选择顺序：
 *   1. DSH_HARK_BRIDGE_HOME（测试与特殊部署用）
 *   2. %LOCALAPPDATA%\dsh-hark-bridge（Windows 常规位置）
 *   3. ~/.dsh-hark-bridge
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = 'settings.json';

export function dataDir() {
  const custom = process.env.DSH_HARK_BRIDGE_HOME;
  if (custom && custom.trim()) return path.resolve(custom.trim());
  const local = process.env.LOCALAPPDATA;
  if (local && local.trim()) return path.join(local.trim(), 'dsh-hark-bridge');
  return path.join(os.homedir(), '.dsh-hark-bridge');
}

export function storePath() {
  return path.join(dataDir(), FILE);
}

/**
 * 读覆盖值。文件不存在、内容坏掉都当「没有覆盖」，绝不让插件装不上。
 * @returns {Record<string, unknown>} 只含用户显式设过的键
 */
export function readOverride() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * 写入若干键；值为 undefined/null/'' 表示删除该键。
 * @param {Record<string, unknown>} patch
 * @returns {string} 写入的文件路径
 */
export function writeOverride(patch) {
  const current = readOverride();
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === '') delete current[key];
    else current[key] = value;
  }
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = storePath();
  // 先写临时文件再 rename：写到一半断电不会留下半个 JSON
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return target;
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
