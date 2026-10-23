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
 *     `appendFileSync` 一行一条，父进程按字节增量读。实测文件是实时可见的。
 *  3. 脚本里的 console.log 会被路由到 stderr，所以两路都解析。
 */
import { spawn } from 'node:child_process';
import {
  closeSync, existsSync, fstatSync, mkdtempSync, openSync, readdirSync, readSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isWin = process.platform === 'win32';

/** stderr 只保留最后这么多字节，避免一个喷日志的进程把内存吃光 */
const STDERR_LIMIT = 64 * 1024;

/** 临时目录前缀，清理函数按它扫描 */
const TEMP_PREFIX = 'dsh-hark-ego-';

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
 * 清理上次运行残留的临时目录。
 *
 * Windows 上子进程被杀之后，仍被占用的文件会让 rmSync 报 EBUSY；脚本自带的
 * 自毁逻辑会让孙进程自己退出，但可能已经来不及删目录。所以插件启动时扫一遍。
 * @param {number} [maxAgeMs] 超过这个年龄的目录才删，默认 24 小时
 * @returns {number} 删掉的目录数
 */
export function cleanupTempDirs(maxAgeMs = 24 * 60 * 60 * 1000) {
  const root = tmpdir();
  let removed = 0;
  let names = [];
  try { names = readdirSync(root); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const dir = join(root, name);
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      if (Date.now() - st.mtimeMs < maxAgeMs) continue;
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed += 1;
    } catch { /* 还被占着，下次再说 */ }
  }
  return removed;
}

/**
 * 把用户脚本包一层：把 console.log / console.error 改成往事件文件里追加一行。
 * 脚本本身完全不用改，仍然写 console.log(JSON.stringify({...}))。
 *
 * 注意 ego 运行时的 console 对象上 log/error 是只读属性，不能 Object.assign，
 * 只能整体换掉 globalThis.console。其余方法（warn/debug…）从原对象绑定过来保留。
 *
 * 顺带注入自毁逻辑（审查意见 B2）：父进程 kill 掉直接子进程后，ego-browser 内部
 * 起的 node/worker 孙进程在 Windows 上不会跟着死。它们会继续每 pollMs 读一次
 * innerText，还会一直占着事件文件，导致临时目录删不掉。所以脚本自己必须能退出：
 *   1. 事件文件所在目录已不存在（父进程清理完了）；
 *   2. 父进程写了 stop 文件；
 *   3. 超过硬截止时间（父进程注入，比 #ask 的超时略长）；
 *   4. 连续 20 次写事件文件都失败（文件被占用/权限变了，事件已经送不出去）。
 * 末尾用 process.exit 兜底，不依赖事件循环自然清空 —— 页面上的 waitForTimeout
 * 可能还挂着一堆计时器。
 */
function wrapScript(source, eventsFile, hardDeadlineMs) {
  return `import { appendFileSync as __append, existsSync as __exists } from 'node:fs';
import { dirname as __pathDir } from 'node:path';
const __events = ${JSON.stringify(eventsFile)};
const __dir = __pathDir(__events);
const __stopFile = __dir + '/stop';
const __deadline = ${Date.now()} + ${Math.max(60_000, Number(hardDeadlineMs) || 0)};
const __hark = { fails: 0, dead: false };
const __emit = (...a) => {
  if (__hark.dead) return;
  if (Date.now() > __deadline || !__exists(__dir) || __exists(__stopFile)) {
    __hark.dead = true;
    process.exit(0);
  }
  const line = a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
  try { __append(__events, line + '\\n'); __hark.fails = 0; } catch {
    if (++__hark.fails >= 20) { __hark.dead = true; process.exit(0); }
  }
};
const __real = globalThis.console;
const __console = {};
for (const k of Object.keys(__real)) {
  __console[k] = typeof __real[k] === 'function' ? __real[k].bind(__real) : __real[k];
}
__console.log = __emit;
__console.error = __emit;
globalThis.console = __console;
try {
${source}
} catch (e) {
  __emit(JSON.stringify({ ok: false, phase: 'script', error: String((e && e.message) || e) }));
}
process.exit(0);
`;
}

/**
 * 杀掉整棵进程树。
 *
 * 为什么不能只 `child.kill()`：ego-browser 自己会再拉 Chromium 子进程。
 * Windows 上 SIGKILL 只作用于直接子进程，孙进程会变孤儿留在后台——
 * 用户会看到「明明取消了，ego 窗口还开着」，而且它们还占着 profile 锁，
 * 下次启动直接失败。macOS/Linux 同理：不杀进程组，Chromium 的子进程照样活着。
 *
 * 三平台各自的正确做法：
 *   - Windows：`taskkill /T /F`（/T 连子孙，/F 强杀）
 *   - POSIX：子进程以 `detached: true` 启动时自成进程组（pgid = pid），
 *     对 `-pid` 发信号等于对整个组发信号
 *   - 兜底：对直接子进程 SIGKILL
 */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, detached: true,
      }).on('error', () => { /* 没有 taskkill 就退回下面 */ });
      return;
    } catch { /* 继续走下面的兜底 */ }
  } else if (child.pid) {
    // 负号 = 整个进程组。子进程没 detached 时 pgid 是父进程的组，
    // 那样杀 -pid 会连自己一起杀——所以先确认它真的自成了组长。
    try {
      if (process.platform !== 'win32' && isGroupLeader(child.pid)) {
        process.kill(-child.pid, 'SIGKILL');
        return;
      }
    } catch { /* ESRCH：已经没了，走兜底 */ }
  }
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
}

/** 判断某个 pid 是不是自己进程组的组长（POSIX） */
function isGroupLeader(pid) {
  try {
    return process.getpgid(pid) === pid;
  } catch {
    return false;
  }
}

/**
 * Windows 上 .cmd / .bat 不能直接 spawn（EINVAL），必须经 shell。
 * 真实的 ego-browser 是 .exe，永远走不到这里；这套判断只服务于包装脚本
 * （测试替身、便携安装、CI）。
 */
function needsShell(exe) {
  return isWin && /\.(cmd|bat)$/i.test(exe);
}

/**
 * 跑一段 ego nodejs 脚本，把脚本打印的每条 `{ok:...}` JSON 作为一个事件依次 yield。
 *
 * consumer 提前 break、抛错、或 signal abort 都会 kill 掉子进程（Windows 上整棵树）。
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] 整体超时，超时抛 name='EgoTimeoutError'
 * @param {number} [opts.pollMs] 轮询事件文件的间隔，默认 120ms
 * @param {number} [opts.hardDeadlineMs] 注入脚本的自毁期限，默认 timeoutMs + 60s
 */
export async function* streamEgoScript(source, { exePath, signal, timeoutMs, pollMs = 120, hardDeadlineMs } = {}) {
  const exe = findEgoBrowser(exePath);
  if (!exe) {
    const e = new Error('没有找到 ego-browser。请确认已安装 ego lite（ego-browser 与 ego.exe 在同一个 Application 目录下）');
    e.name = 'EgoMissingError';
    throw e;
  }
  if (signal?.aborted) throw abortError(signal);

  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const scriptFile = join(dir, 'script.mjs');
  const eventsFile = join(dir, 'events.jsonl');
  const stopFile = join(dir, 'stop');
  const scriptDeadline = Number(hardDeadlineMs) || (Number(timeoutMs) ? Number(timeoutMs) + 60_000 : 0);
  writeFileSync(scriptFile, wrapScript(source, eventsFile, scriptDeadline), 'utf8');
  writeFileSync(eventsFile, '', 'utf8');

  const scriptFd = openSync(scriptFile, 'r');
  let eventsFd = -1;
  let child = null;
  const closeAll = () => {
    try { closeSync(scriptFd); } catch { /* 已关 */ }
    if (eventsFd >= 0) { try { closeSync(eventsFd); } catch { /* 已关 */ } eventsFd = -1; }
  };
  const cleanup = () => {
    closeAll();
    // Windows 上刚被杀的进程可能还短暂占着文件，让 rmSync 自己重试几轮。
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 留着给下次启动清 */ }
  };

  try {
    // 真实 ego-browser 是 exe，直接 spawn。但有人会用 .cmd/.bat 做包装脚本
    // （CI、便携安装、测试替身），Windows 上直接 spawn 这类文件会 EINVAL，
    // 必须交给 shell。参数只有 'nodejs' 一个，没有注入风险。
    //
    // POSIX 上加 detached 是为了 killTree 能杀整个进程组：ego 会再拉 Chromium
    // 子进程，不 detached 时它们和 DSH 同组，杀 -pid 会连 DSH 一起带走。
    // Windows 上不加——那会弹出一个新控制台窗口。
    const opts = { stdio: [scriptFd, 'ignore', 'pipe'], windowsHide: true, detached: !isWin };
    child = needsShell(exe)
      ? spawn(`"${exe}" nodejs`, { ...opts, shell: true })
      : spawn(exe, ['nodejs'], opts);
  } catch (e) {
    closeAll();
    cleanup();
    throw e;
  }

  let exited = null;
  let killed = false;
  let yielded = false;
  let stderr = '';
  let offset = 0;
  let pending = Buffer.alloc(0);

  const kill = () => {
    if (killed || exited !== null) return;
    killed = true;
    // 先让脚本自己看到 stop 文件退出（孙进程可能不响应 taskkill），再杀整棵树。
    try { writeFileSync(stopFile, '1'); } catch { /* 目录可能已删 */ }
    killTree(child);
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  };
  const onAbort = () => kill();
  signal?.addEventListener('abort', onAbort, { once: true });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(stderr.length - STDERR_LIMIT);
  });
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

  /**
   * 按字节增量读事件文件。
   *
   * 早先的实现每轮 readFileSync 整文件再 slice，长对话（一页几百 KB × 上千轮）
   * 是 O(n²)，而且 offset 按 UTF-16 字符算、会把没写完的半行和多字节字符
   * 一起吞掉（审查意见 B3）。现在只读新字节，并且只消费到最后一个换行为止，
   * 剩下的半行留在 pending 里等下一轮补齐。
   */
  const readNewLines = () => {
    if (eventsFd < 0) {
      try { eventsFd = openSync(eventsFile, 'r'); } catch { return []; }
    }
    let size = 0;
    try { size = fstatSync(eventsFd).size; } catch { return []; }
    if (size > offset) {
      const buf = Buffer.alloc(size - offset);
      let n = 0;
      try { n = readSync(eventsFd, buf, 0, buf.length, offset); } catch { n = 0; }
      if (n > 0) {
        offset += n;
        const chunk = buf.subarray(0, n);
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      }
    }
    const nl = pending.lastIndexOf(0x0a);
    if (nl < 0) return [];
    const ready = pending.subarray(0, nl).toString('utf8');
    pending = pending.subarray(nl + 1);
    return ready.split(/\r?\n/).filter((l) => l.trim());
  };

  /** 子进程退出后把残留的尾行也吐出来 */
  const readTail = () => {
    const out = readNewLines();
    if (pending.length) {
      const line = pending.toString('utf8');
      pending = Buffer.alloc(0);
      if (line.trim()) out.push(line);
    }
    return out;
  };

  const emitLines = function* (lines) {
    for (const line of lines) {
      const value = parse(line);
      if (!value) continue;
      if (value.ok === false) {
        const e = new Error(value.error || `ego 脚本中止于阶段 ${value.phase || 'unknown'}`);
        e.name = 'EgoStageError';
        e.stage = value.phase;
        throw e;
      }
      yielded = true;
      yield value;
    }
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

      yield* emitLines(readNewLines());

      if (exited !== null) {
        yield* emitLines(readTail());
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

/** 读一个文件（测试与调试用，故意不 export 到公共 API 之外） */
export function readTextFile(path) {
  return readFileSync(path, 'utf8');
}
