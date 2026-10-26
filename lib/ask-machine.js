/**
 * 等回复这件事的状态机，从一个「观测值」推进到下一个。
 *
 * 为什么要单独拆出来：原先这段逻辑有 150 行左右，埋在一个 async 方法里，
 * 每次要改「等待规则」都得在真实浏览器里跑几十秒才知道对不对，而真正复杂的是
 * 判定顺序，不是 IO。拆成纯函数之后，一串真实出现过的观测值就能当成表格来测
 * （见 test/ask-machine.test.mjs），不用碰 ego。
 *
 * 约定：
 * - 这里不读时钟、不抛业务错误、不碰文件系统。`obs.at` 是当前时刻，
 *   错误也是「算出来」放在返回值里，由调用方决定怎么抛。
 * - state 一律返回新对象，方便测试直接比较前后两份。
 */

import { extractReply, footTag } from './protocol.js';

/** 整页文本读空多久之后判定「页面没了」，而不是「Hark 还没回」 */
export const EMPTY_PAGE_MS = 60_000;

/** 发了消息却一直看不到它出现在页面上，超过这个时间就认为发送失败 */
export const SEND_GRACE_MS = 30_000;

/**
 * @typedef {object} AskState
 * @property {{status: string, reply: string}} last 最近一次解析出的回复状态
 * @property {boolean} sentSeen 页面上出现过本次请求
 * @property {number} doneAt 第一次看到结束标记的时刻
 * @property {number} emptySince 整页文本开始为空白的时刻
 * @property {number} mdCards 属于本次回复的 .md 卡片数（取历史最大值）
 * @property {boolean} anchored 是否定位到本次回复的结束标记气泡
 * @property {number} mdTotal 页面上卡片总数（含被位置筛排除的）
 * @property {number} graceUntil 卡片宽限期截止时刻
 * @property {object|null} settled 文字已定稿的结论
 * @property {string[]} warnings
 * @property {boolean} attachReady 附件是否已确认就绪
 * @property {boolean} missingNotified 附件事后校验的缺失清单是否已记过
 */

/**
 * @param {object} [opts]
 * @param {string[]} [opts.warnings] 调用方的告警收集器。**保持同一个数组引用**：
 *   调用方在 ask 之外也拿着这个数组（附件校验、降级路径都会往里写），
 *   复制一份的话那些告警就传不到返回值上了。
 * @returns {AskState}
 */
export function initialState({ warnings = [] } = {}) {
  return {
    last: { status: 'not-sent', reply: '' },
    sentSeen: false,
    doneAt: 0,
    emptySince: 0,
    mdCards: 0,
    anchored: false,
    mdTotal: 0,
    graceUntil: 0,
    settled: null,
    warnings,
    attachReady: false,
    missingNotified: false,
  };
}

/**
 * 这次回复值不值得为它等卡片。
 *
 * `wantsFile === true`：plan/review，产出本来就是文档，等。
 * `wantsFile === 'long'`：chat，只有正文写长了才等——不然每个「收到」都要
 * 白站 8 秒，用户会觉得插件卡。门槛用 `longReplyChars`（默认 300 字符左右）。
 *
 * @param {object} cfg
 * @param {object} s 当前 state（要看它的 last.reply 长度）
 * @returns {boolean}
 */
export function wantsFileNow(cfg, s) {
  const mode = cfg?.wantsFile;
  if (mode === true) return true;
  if (mode !== 'long') return false;
  const min = Number.isFinite(cfg.longReplyChars) ? cfg.longReplyChars : 300;
  if (min <= 0) return true;
  const len = String(s?.last?.reply || '').trim().length;
  return len >= min;
}

/**
 * 把一条 poll 观测折算进 state。
 *
 * @param {AskState} s
 * @param {object} obs
 * @param {object} cfg
 * @param {string} cfg.id 本次请求编号
 * @param {number} cfg.settleMs 看到结束标记后再等多久
 * @param {number} cfg.attachGraceMs 定稿后再等卡片多久
 * @param {boolean|'long'} cfg.wantsFile 这次是否值得等文件：`true` 一律等、
 *   `'long'` 只有正文够长才等、其他值不等
 * @param {number} [cfg.longReplyChars] `'long'` 的门槛（正文达到这么长才等卡片）
 * @param {number} cfg.sendDeadline 发送确认的截止时刻
 * @param {number} cfg.deadline 整体截止时刻
 * @param {string[]} [cfg.uploadNames] 本次上传的文件名，下载时要排掉
 * @param {number} [cfg.emptyPageMs]
 * @returns {{state: AskState, action: string, error?: object}}
 *   action: 'continue' | 'finish' | 'expire' | 'fail'
 */
export function stepPoll(s, obs, cfg) {
  const at = Number(obs.at) || 0;
  const next = { ...s };

  if (Number.isFinite(obs.mdCards) && obs.mdCards > next.mdCards) next.mdCards = Number(obs.mdCards);
  if (obs.anchored === true) next.anchored = true;
  if (Number.isFinite(obs.mdTotal) && obs.mdTotal > next.mdTotal) next.mdTotal = Number(obs.mdTotal);

  // 脚本只回传 footTag 之后的尾部（整页 innerText 会随对话涨到几十上百 KB，
  // 逐轮全量回传是 O(n²)）。这里补回 footTag，让 extractReply 看到的输入
  // 与「整页文本」语义一致。
  //
  // same:true 表示这一轮尾部没变（脚本每 pollMs 都发心跳，只在变化时带 text）。
  // 这时不能把 last 重置成 not-sent，否则刚看到的结束标记会被下一轮心跳抹掉，
  // settle 永远等不满。
  if (obs.same !== true) {
    const tail = obs.sent === false ? '' : String(obs.text ?? '');
    const text = obs.sent === false ? '' : footTag(cfg.id) + tail;
    next.last = extractReply(text, cfg.id);
  }

  // pageLen 是脚本读到的整页长度：区分「页面没了」和「Hark 还没回」
  // ——后者尾部本来就是空的，不能当成页面丢失。
  const pageLen = Number.isFinite(obs.pageLen) ? Number(obs.pageLen) : -1;
  if (next.last.status !== 'not-sent') next.sentSeen = true;
  if (!next.sentSeen && at > cfg.sendDeadline) {
    return {
      state: next,
      action: 'fail',
      error: { kind: 'not-sent', message: `30 秒内页面上没出现已发送的消息（${footTag(cfg.id)}），发送可能失败` },
    };
  }

  // 页面丢了（导航走 / 标签被关 / 渲染崩了）：整页文本会变成空。
  // 早先的实现会一路轮询到 timeoutMin 才报超时，把「页面没了」和「Hark 没回」
  // 混成同一个错误。
  if (next.sentSeen && pageLen === 0) {
    if (!next.emptySince) next.emptySince = at;
    else if (at - next.emptySince > (cfg.emptyPageMs || EMPTY_PAGE_MS)) {
      next.emptySince = 0;
      return { state: next, action: 'fail', error: { kind: 'page-lost' } };
    }
  } else {
    next.emptySince = 0;
  }

  // settle：看到结束标记后再等一会儿，确认它没被后续内容改掉
  // （流式渲染时标记可能先出现、随后正文还在补）。
  if (next.last.status === 'done') {
    if (!next.doneAt) next.doneAt = at;
    if (at - next.doneAt >= cfg.settleMs) {
      // 文字定稿这件事本身要先记下来，和「有没有卡片」分开：
      // 宽限期可能撞上整体超时，那时回复其实已经完整，不能报「没给出结束标记」。
      next.settled = {
        // id 必须带上：下载附件时要靠它拼出本次回复的结束标记当锚点，
        // 少了它 endTag(undefined) 会让「找属于本次的卡片」永远失败。
        id: cfg.id,
        done: true,
        reply: next.last.reply,
        attachReady: next.attachReady,
        mdCards: next.mdCards,
        anchored: next.anchored,
        mdTotal: next.mdTotal,
        warnings: next.warnings,
        uploadNames: Array.isArray(cfg.uploadNames) ? cfg.uploadNames : [],
      };
      // 卡片宽限期：Hark 的渲染顺序是「文字气泡（结尾是结束标记）→ 文件卡片」，
      // 卡片要等文件上传完才出现，可能比文字晚一两秒。settle 只保证文字稳定，
      // 文字稳定了卡片未必出来——那时 mdCards 还是 0，就会直接不下载，
      // 整条文件通道在 plan/review 上等于没生效。
      //
      // `wantsFile` 有三种取值：
      //   true   一律等（plan/review：它们的产出本来就是文档）
      //   'long' 只有正文够长才等（chat：回答超过 longReplyChars 才值得存文件，
      //          否则为一句「收到」多停 8 秒纯属浪费）
      //   其他   不等
      if (wantsFileNow(cfg, next) && next.mdCards === 0 && next.anchored) {
        if (!next.graceUntil) next.graceUntil = at + cfg.attachGraceMs;
        if (at < next.graceUntil) return { state: next, action: 'continue' };
        return { state: next, action: 'finish' };
      }
      return { state: next, action: 'finish' };
    }
    return { state: next, action: 'continue' };
  }

  next.doneAt = 0;
  next.graceUntil = 0;
  // 结束标记又不见了（Hark 在补写正文）：之前记的定稿作废。
  next.settled = null;
  return { state: next, action: 'continue' };
}

/**
 * 把一条非 poll 事件折算进 state。返回 null 表示这条事件与回复判定无关。
 * @returns {AskState|null}
 */
export function stepEvent(s, ev) {
  if (ev.phase === 'attach') {
    // 失败型 attach 由 ego 抛 EgoStageError，这里不重复处理。
    if (ev.ok === false) return s;
    return { ...s, attachReady: true };
  }
  // 发送后校验的缺失清单：不在脚本里直接判死，交给调用方决定要不要提示用户，
  // Hark 侧有时只是气泡文字还没渲染完，文件其实已经在对话里了。
  if (ev.phase === 'attach-missing') {
    const names = Array.isArray(ev.names) ? ev.names.map(String) : [];
    if (!names.length || s.missingNotified) return s;
    // 就地 push：warnings 是调用方那个数组的引用，换新数组会让告警传不回去。
    s.warnings.push(`发送后校验未在气泡里找到附件：${names.join('、')}`);
    return { ...s, missingNotified: true };
  }
  return null;
}

/**
 * 收尾：循环结束后该返回什么。
 * @param {AskState} s
 * @param {{finished?: object|null}} opts
 * @returns {{state: AskState, action: string, result?: object, error?: object}}
 */
export function finishState(s, { finished = null } = {}) {
  // finished 和 settled 都算成功：宽限期里 poll 流提前结束、或者刚好撞上整体超时，
  // 都不改变「文字已经完整」这个事实，只是卡片还没等到——那就按「没有附件」处理，
  // 绝不能报超时。
  const out = finished || s.settled;
  if (out) return { state: s, action: 'finish', result: out };
  const partial = String(s.last.reply || '').trim();
  return {
    state: s,
    action: 'fail',
    error: { kind: 'timeout', partial, reply: partial },
  };
}
