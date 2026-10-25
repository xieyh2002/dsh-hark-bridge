/**
 * 宿主 Node 版本检查（0.10.0）
 *
 * 插件跑在 DSH 主进程里，用的是 DSH 自带或系统里的那个 Node，插件自己换不了。
 * 2026-10-21 Node.js 发布安全更新，修了 10 个漏洞，最重的是内置 Brotli 解码器的
 * 越界写（CVE-2026-111497，可远程执行代码）。不需要代码主动调 Brotli 也可能触发：
 * 内置 fetch() 遇到 `Content-Encoding: br` 会自动解压。
 *
 * 每条支持线只有一个最低修复版本；奇数线和 20 及更早都已 EOL，不会再有修复。
 * 注意 `>=22.23.4` 这种写法会把 24.0.0～24.22.0 这些未修复版本也放进来，
 * 所以这里按主版本逐条比，package.json 的 engines 也写成按线的区间。
 *
 * 检测只提示、不阻断：拒绝启动会让用户连 /hark-diag 都跑不了，也就看不到该怎么办。
 */

/** 每条仍受支持的线的最低修复版本（2026-10-21 安全更新） */
export const PATCHED_MIN = Object.freeze({
  22: [22, 23, 4],
  24: [24, 22, 1],
  26: [26, 12, 1],
});

/** 27 及以后的版本线都在这次更新之后才发布，天然包含修复 */
const NEWEST_KNOWN_MAJOR = 26;

export const ADVISORY_URL = 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases';

function parse(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function lessThan(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

const fmt = (v) => v.join('.');
const SUGGEST = `${fmt(PATCHED_MIN[22])} / ${fmt(PATCHED_MIN[24])} / ${fmt(PATCHED_MIN[26])}`;

/**
 * @param {string} [version] 默认取 process.versions.node
 * @returns {{ ok: boolean|null, version: string, detail: string, hint?: string }}
 *   ok === null：版本号读不出来，不当成错误，只提醒
 */
export function checkNodeVersion(version = process.versions?.node) {
  const v = parse(version);
  const shown = version ? `Node ${String(version).replace(/^v/, '')}` : 'Node 版本未知';
  if (!v) {
    return { ok: null, version: String(version ?? ''), detail: `${shown}，无法判断是否含 2026-10-21 安全修复` };
  }
  const [major] = v;
  const min = PATCHED_MIN[major];

  if (min) {
    if (!lessThan(v, min)) return { ok: true, version: fmt(v), detail: `${shown}，已含 2026-10-21 安全修复` };
    return {
      ok: false,
      version: fmt(v),
      detail: `${shown} 低于 ${fmt(min)}，缺 2026-10-21 安全修复（含 Brotli 远程代码执行 CVE-2026-111497）`,
      hint: `升级到 ${fmt(min)} 或更高后重启 DSH。详情：${ADVISORY_URL}`,
    };
  }
  if (major > NEWEST_KNOWN_MAJOR) {
    return { ok: true, version: fmt(v), detail: `${shown}，晚于这次安全更新发布的版本线` };
  }
  return {
    ok: false,
    version: fmt(v),
    detail: `${shown} 已停止支持，拿不到 2026-10-21 安全修复（含 Brotli 远程代码执行 CVE-2026-111497）`,
    hint: `换到仍受支持的版本线（${SUGGEST} 或更高）后重启 DSH。详情：${ADVISORY_URL}`,
  };
}
