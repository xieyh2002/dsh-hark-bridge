/**
 * ego 驱动层：直接用用户正在运行的那个 ego 浏览器。
 *
 * 不走自建 CDP 实例，原因（实测）：
 *  - 自建实例用的是全新 user-data-dir，等于一个没登录的浏览器，用户得重新登录 Hark；
 *  - 用户 ego 的 Cookies 文件被运行中的进程独占锁定，复制不出来；
 *  - 同一个 user-data-dir 也不能再起第二个带调试端口的实例（Chromium 单例会把命令
 *    转发给已有进程然后自己退出）。
 *
 * 所以改成通过 `ego-browser nodejs` 这个官方通道，连到用户已有的 ego 上操作页面。
 * 一次 ask = 一个子进程，脚本里把「打字 → 回车 → 轮询页面文本」跑完，
 * 期间父进程随时可以 kill 掉它来取消。
 *
 * 另一条实测结论：如果同时存在第二个 ego 实例（比如插件以前自建的空 profile 实例），
 * ego-browser 会随机连到其中一个，连到空的那个就报 onboarding。所以这里绝不自己起浏览器。
 *
 * 三个踩过的坑，都体现在下面的实现里：
 *  1. 脚本通过 stdin 管道喂进去会随机挂死（约 1/3 概率不输出也不退出）→ 改成写临时文件，
 *     以文件句柄作 stdin。
 *  2. `ego-browser nodejs` 的 stdout/stderr 不会实时回传，要等子进程退出才一次性给出。
 *     需要边跑边收事件的场景（轮询页面文本）必须另开通道 → 用事件文件，脚本里
 *     `appendFileSync` 一行一条，父进程轮询读增量。实测文件是实时可见的。
 *  3. 脚本里的 console.log 会被路由到 stderr，所以两路都解析。
 */
import { spawn } from 'node:child_process';
import {
  closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isWin = process.platform === 'win32';

/**
 * 找 ego-browser 可执行文件。
 * 注意区分两个文件：Application\ego.exe 是 Chromium 主体，不能跑 nodejs 子命令；
 * Application\<version>\ego-browser.exe 才是 CLI。
 */
export function findEgoBrowser(preferred) {
  if (preferred && existsSync(preferred)) return preferred;
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter(Boolean);

  const candidates = [];
  for (const root of roots) {
    const app = join(root, 'Citro Labs', 'ego lite', 'Application');
    candidates.push(join(app, 'ego-browser.exe'));
    try {
      // ego lite/Application/<ver>/ego-browser.exe
      for (const d of readdirSync(app)) candidates.push(join(app, d, 'ego-browser.exe'));
    } catch { /* 目录不存在就跳过 */ }
  }
  if (!isWin) {
    candidates.unshift('/Applications/ego lite.app/Contents/MacOS/ego-browser');
    candidates.push('/usr/bin/ego-browser');
  }
  return candidates.find((p) => existsSync(p)) || null;
}

/** 子进程被取消时抛的错误，名字与其他取消路径保持一致 */
export function abortError(signal) {
  const why = signal?.reason;
  const e = new Error(why?.message || '已取消');
  e.name = 'AbortError';
  return e;
}

/**
 * 把用户脚本包一层：把 console.log / console.error 改成往事件文件里追加一行。
 * 脚本本身完全不用改，仍然写 console.log(JSON.stringify({...}))。
 *
 * 注意 ego 运行时的 console 对象上 log/error 是只读属性，不能 Object.assign，
 * 只能整体换掉 globalThis.console。其余方法（warn/debug…）从原对象绑定过来保留。
 */
function wrapScript(source, eventsFile) {
  return `import { appendFileSync as __append } from 'node:fs';
const __events = ${JSON.stringify(eventsFile)};
const __emit = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
  try { __append(__events, line + '\\n'); } catch {}
};
const __real = globalThis.console;
const __console = {};
for (const k of Object.keys(__real)) {
  __console[k] = typeof __real[k] === 'function' ? __real[k].bind(__real) : __real[k];
}
__console.log = __emit;
__console.error = __emit;
globalThis.console = __console;
${source}
`;
}

/**
 * 跑一段 ego nodejs 脚本，把脚本打印的每条 `{ok:...}` JSON 作为一个事件依次 yield。
 *
 * consumer 提前 break、抛错、或 signal abort 都会 kill 掉子进程。
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] 整体超时，超时抛 name='EgoTimeoutError'
 * @param {number} [opts.pollMs] 轮询事件文件的间隔，默认 120ms
 */
export async function* streamEgoScript(source, { exePath, signal, timeoutMs, pollMs = 120 } = {}) {
  const exe = findEgoBrowser(exePath);
  if (!exe) {
    const e = new Error('没有找到 ego-browser。请确认已安装 ego lite（ego-browser 与 ego.exe 在同一个 Application 目录下）');
    e.name = 'EgoMissingError';
    throw e;
  }
  if (signal?.aborted) throw abortError(signal);

  const dir = mkdtempSync(join(tmpdir(), 'dsh-hark-ego-'));
  const scriptFile = join(dir, 'script.mjs');
  const eventsFile = join(dir, 'events.jsonl');
  writeFileSync(scriptFile, wrapScript(source, eventsFile), 'utf8');
  writeFileSync(eventsFile, '', 'utf8');

  const fd = openSync(scriptFile, 'r');
  let child = null;
  try {
    child = spawn(exe, ['nodejs'], { stdio: [fd, 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    try { closeSync(fd); } catch { /* 已关 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    throw e;
  }
  const cleanup = () => {
    try { closeSync(fd); } catch { /* 已关 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  };

  let exited = null;
  let killed = false;
  let yielded = false;
  let stderr = '';
  let offset = 0;

  const kill = () => {
    if (killed || exited !== null) return;
    killed = true;
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  };
  const onAbort = () => kill();
  signal?.addEventListener('abort', onAbort, { once: true });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', () => { /* 实测无实时内容，忽略 */ });
  const exitPromise = new Promise((resolve) => {
    child.on('error', (e) => {
      stderr += `\n${e.message}`;
      if (exited === null) exited = { code: -1 };
      resolve();
    });
    child.on('close', (code) => {
      if (exited === null) exited = { code };
      resolve();
    });
  });

  const parse = (line) => {
    const t = line.trim();
    if (!t.startsWith('{')) return null;
    try {
      const v = JSON.parse(t);
      return v && typeof v === 'object' && 'ok' in v ? v : null;
    } catch { return null; }
  };

  /** 从事件文件里读自从上次以来的新行 */
  const readNewLines = () => {
    let text = '';
    try { text = readFileSync(eventsFile, 'utf8'); } catch { return []; }
    if (text.length <= offset) return [];
    const chunk = text.slice(offset);
    offset = text.length;
    return chunk.split(/\r?\n/).filter((l) => l.trim());
  };

  const startedAt = Date.now();
  let tick = 0;

  try {
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      if (timeoutMs && Date.now() - startedAt > timeoutMs) {
        const e = new Error(`ego 脚本超过 ${Math.round(timeoutMs / 1000)} 秒没有结束`);
        e.name = 'EgoTimeoutError';
        throw e;
      }

      for (const line of readNewLines()) {
        const value = parse(line);
        if (!value) continue;
        if (value.ok === false) {
          const e = new Error(`ego 脚本中止于阶段 ${value.phase || 'unknown'}`);
          e.name = 'EgoStageError';
          e.stage = value.phase;
          throw e;
        }
        yielded = true;
        yield value;
      }

      if (exited !== null) {
        // 子进程退出后可能还有没读到的尾巴
        for (const line of readNewLines()) {
          const value = parse(line);
          if (!value) continue;
          if (value.ok === false) {
            const e = new Error(`ego 脚本中止于阶段 ${value.phase || 'unknown'}`);
            e.name = 'EgoStageError';
            e.stage = value.phase;
            throw e;
          }
          yielded = true;
          yield value;
        }
        break;
      }

      // setTimeout 而不是 await 事件：脚本可能被 process.exit 干掉，也可能什么都不打印，
      // 靠定时轮询文件才不会被"永不发生"的通知卡死。
      await new Promise((r) => { tick = setTimeout(r, pollMs); });
    }
  } finally {
    clearTimeout(tick);
    signal?.removeEventListener('abort', onAbort);
    kill();
    await exitPromise.catch(() => {});
    cleanup();
  }

  if (signal?.aborted) throw abortError(signal);

  const code = exited?.code;
  const all = stderr.trim();
  if (code === 0 && yielded) return;
  if (/onboarding/i.test(all)) {
    const e = new Error('ego 还没完成初始化引导（onboarding）。请先在 ego 窗口里点完引导再重试');
    e.name = 'EgoOnboardingError';
    throw e;
  }
  if (code === 0) return;
  const e = new Error(`ego 调用失败（exit ${code}）：${all.slice(0, 600) || '没有输出'}`);
  e.stderr = all;
  throw e;
}

/** 一次性跑完取最后一个事件（给 /hark-login 这类短操作） */
export async function runEgoScript(source, opts = {}) {
  let last = null;
  for await (const ev of streamEgoScript(source, opts)) last = ev;
  return last ?? { ok: true };
}
