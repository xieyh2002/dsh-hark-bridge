# 更新记录

版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.5.0

方案和审查改成 Markdown 文件交付，附件双向传递。

起因：Hark 的方案/审查动辄上万字，塞在工具返回值里既挤占上下文，用户也没法直接打开、搜索、贴给别人。

### 下行：回复落盘

- Hark 的回复同时写一份 Markdown 到 `<工作区>/.hark/replies/`，文件名 `<时间>-<模式>-<请求编号>.md`。
- 文件带 YAML front matter：请求编号、模式、保存时间、发过哪些附件。
- 工具返回值改为「文件路径 + 前 1200 字预览」，不再回全文。落盘失败时退回全文——至少不会什么都没给模型。
- 写盘走「先写临时文件再 rename」，并校验字节数；同名自动加 `-2` 后缀，不覆盖旧文件。
- `replyDir` 可换目录，但必须落在工作区内（用 `path.relative` 判断，不是字符串前缀），越界只降级成不落盘 + 一条警告，不阻断对话。

### 上行：附件上传

- `ask_hark` 新增 `attachments` 参数，传工作区相对路径。
- 文件作为**真正的附件**上传，不是把内容粘进正文——格式和行号都能保真。
- 校验：绝对路径、越界、`.env`/私钥之类敏感文件、单文件与总量超限、重复文件，逐条给出原因；一个可用都没有才报错，部分失败会附警告。
- 上传名做扁平化（`lib/bridge.js` → `lib__bridge.js`），用 `__` 而不是 `_`，避免 `a/b.js` 和 `a b.js` 撞名静默丢文件。
- 附件上传超时自动降级成把内容贴进正文，并在返回值里注明；内联后仍超 `maxChars` 才报错。

### 下行：附件下载

- Hark 回复里挂了 `.md` 附件时，把文件本身下载到同一目录（`<请求编号>.hark.md`）。附件比气泡里的渲染文本完整——气泡会压掉连续空行。
- 用 `page.fetch` 而不是 `waitForEvent('download')`：实测后者在 ego 里拿不到事件，而前者带页面 cookie 能直接拿到字节，还能指定落盘路径。
- 下载失败只记一条警告，不影响已经拿到的正文。

### 短回复不折腾文件

- 新增配置 `markdownMinChars`（默认 1200）。回复不够长、或虽然长但没有文档结构（标题/列表/代码块/表格至少两样）时，直接读正文，不滚页面找卡片。
- 起因：一句「收到」也去滚到底、找卡片、点开、下载，花十几秒拿回来的还是那句「收到」；而且 Hark 短回复时根本不生成卡片，会翻到别人的卡片或自己刚上传的附件。
- 落盘同样按这个门槛：短回复不写文件，工作区不会被两行小文件塞满。
- 设为 0 表示不看门槛一律走文件通道（测试用）。

### 其他

- 新增 `lib/attach.js`（上行）、`lib/reply-store.js`（下行）。
- 配置新增 11 项：`saveReplies`、`replyDir`、`fetchAttachment`、`markdownMinChars`、`attachTimeoutSec`、`fileInputSelector`、`attachmentSelector`、`maxFileBytes`、`maxTotalBytes`、`maxFiles`、`autoAttachOverflow`；删掉 `profileDir`、`debugPort`（0.3.0 起已无用）。
- `normalizeAttachments` 在「非空但一条都认不出来」时抛错，而不是静默丢光——那是调用方把路径数组当成品传进来的信号。
- 新增 `test/attach.test.mjs`（24 项）、`test/reply-store.test.mjs`（14 项）、`test/tool-output.test.mjs`（9 组）。`npm test` 从七项变十项；`test:e2e` 从 15 项断言增到 19 项，加了附件往返与下载的真实链路验证。

## 0.4.0

一轮针对 Hark 代码审查意见的集中修复。三个阻断项、若干严重项，以及顺手发现的几处真问题。

### 阻断

- **`[/DSH#id]` 不再当结束标记。** `extractReply` 改为以 `[[DSH-END#id]]` 为唯一锚点，取**最后一个位于行尾**的标记。旧逻辑会把「Hark 在回复里解释协议、引用请求、或代码块里恰好有一行以它结尾」判成完成，后半截回复被丢掉，上层却拿到一个看起来完整的结论——这是最危险的失败模式。`[/DSH#id]` 现在只用于定位回复起点。老对话可传 `{ acceptFootFallback: true }` 兼容，默认关闭。
- **脚本自毁。** `ego-browser nodejs` 子进程被 kill 时可能留下孤儿脚本继续跑。现在脚本每次 `emit` 都检查三件事：硬截止时间到了、事件目录被删、目录里出现 `stop` 文件——任一成立就 `process.exit(0)`；`appendFileSync` 连续失败 20 次也退出。Windows 上改用 `taskkill /T /F` 杀整棵进程树。
- **事件文件按字节增量读。** 每轮只 `readSync` 新写入的字节，且只消费到最后一个换行（半行留到下一轮）。旧实现每轮 `readFileSync` 整个文件再切，是 O(n²)，且偏移量按 UTF-16 字符算会把半行和多字节字符切坏。

### 严重

- **单轮读页失败不再直接判死。** 连续失败 5 次才上抛。旧实现把错误吞成空字符串，父进程会误报「页面读不到内容了」，用户按提示 `/hark-login` 重开也没用。
- **排队中的请求能取消。** 还没轮到就按停止，立刻结束，不会排在前面那个请求后面白等。
- **跨进程锁。** 多个 DSH 会话同时用不会互相打字（锁文件 `<数据目录>/bridge.lock`）。持有者进程已死或锁超过 10 分钟会被自动回收，等待上限 2 分钟。
- **settle 期间持续轮询。** 看到结束标记后继续 poll 到 `settleMs`，期间变回非 done 就重新计时。旧实现 `sleep` 完直接返回，看不到流式渲染期间的后续变化。
- **页面丢失早报。** 发出去之后整页文本变空超过 60 秒，报「Hark 页面忽然读不到内容了」，不再干等到 `timeoutMin`。
- **握手遇登录错误立刻上抛。** 找不到输入框说明没登录或地址不对，不再让握手和正式请求各白等 `loginWaitSec`（合起来 4 分钟才报一个本该 1 分钟就报的错）。
- **每条消息自带格式说明。** 固定提示行写明「回复最后请单独一行写 `[[DSH-END#<编号>]]`」。对话上下文被压缩、握手没成功，也不会退化成纯靠猜。`RULES_VERSION` 不变，老用户不会重收规则。
- **goto 失败有独立错误。** 页面跳不过去时报 `phase: 'goto'`，不再和「找不到输入框」混成一个错误。
- **`maxChars` 在入队前检查**，超长正文不会被写进队列。

### 其他

- **数值配置项加边界**：`timeoutMin` 1–120、`loginWaitSec` 5–600、`pollMs` 200–30000、`settleMs` 0–30000、`maxChars` 1000–400000。手改 `settings.json` 写进非法值时会被夹回合法范围，否则 `timeoutMin * 60000` 是 `NaN`，定时器永不触发，请求挂死。
- **启动时清理陈旧临时目录**（`tmpdir()` 下 `dsh-hark-ego-` 前缀且超过 24 小时的）。
- **轮询回传改为只发尾部**：脚本只回传 `[/DSH#id]` 之后的文本，且只在变化时带正文，其余轮次发心跳。页面越长事件文件越大、父进程解析越慢的问题解决了。
- 新增 `test/ego.test.mjs`（7 项）与 `test/bridge-lock.test.mjs`（5 项）；`test/protocol.test.mjs` 增加 B1 回归；`test/config-schema.test.mjs` 增加夹取断言。测试总数 5 → 7。

## 0.3.2

- **修掉「拿到空回复」和「回复被提前截断」两个误判。** `extractReply` 原来的判定过于粗暴：只要页面里出现标记就算结束。实际踩到两种情况：
  - **空回复**：发送瞬间，请求文本可能同时存在于输入框和消息气泡里，或者页面把用户消息渲染了两份。第二份的 `[/DSH#id]` 会被当成结束标记，回复区间是空的，结果返回一个空字符串当作 Hark 的答案。现在标记前的正文为空时一律继续等，并且紧跟在后面的自身副本（以 `[DSH#id]` 开头）会被整段跳过。
  - **提前截断**：Hark 在正文里引用标记（比如解释协议本身、「你消息结尾的 `[/DSH#id]` 我看到了」）时，第一处引用就会被当成结束。现在标记必须位于**行尾**（后面只有空白）才算结束。
- 结束标记的定位抽成 `findMarkerLine(s, markers)` 单独导出，方便测试。
- 为什么是「行尾」而不是「整行」：Hark 页面按 Markdown 渲染，单个换行会被并成空格，「最后一句\n`[[DSH-END#id]]`」在 `innerText` 里可能变成「最后一句 `[[DSH-END#id]]`」。要求整行会让这种回复永远等到超时，要求行尾仍能挡住正文中间的引用。
- 顺带处理 CRLF：进入 `extractReply` 时先统一去掉 `\r`。
- `test/protocol.test.mjs` 增加 12 条断言覆盖上述场景（双份渲染、渲染半截、行内引用、Markdown 软换行、CRLF、标记前后空白）。

## 0.3.1

- **首次使用自动告知 Hark 协议规则。** 每个 Hark 地址第一次被调用时，先单独发一条规则说明：消息格式、回复末尾必须写 `[[DSH-END#<同一个编号>]]`、编号要一致、标记只写一次。Hark 回一句「规则已收到」即握手完成，记进 `settings.json` 的 `handshakes`，同一地址不再重发；换新地址会重新握手。握手失败不阻断正式请求。
- **修掉一个取消路径的 bug。** 已 abort 的请求原本还会先发一轮握手，等于用户按了停止之后插件仍然往页面里塞了内容。现在 `ask()` 在进队列前就检查 `signal.aborted`。
- **所有测试不再污染用户配置。** 三个会碰 `lib/store.js` 的测试都改用 `DSH_HARK_BRIDGE_HOME` 指向临时目录，跑完删除。之前 `npm test` 会把假地址 `https://hark.example/p/1` 写进真实的 `settings.json`。
- **e2e 增加握手场景**，并同步隔离 store。

## 0.3.0

**浏览器驱动层整体换掉：从「自建 CDP 实例」改成「复用你正在用的 ego」。**

这是本次最大的变更，起因是用户反馈「为什么不调用我设置好的 ego，非要调用一个全新的」。旧实现自己 spawn 一个带 `--remote-debugging-port` 的浏览器，用的是全新 `user-data-dir`，等于一个没登录的浏览器，用户得重新登录 Hark。

试过并放弃的绕过方案：

- 复制用户 ego 的 `Cookies` 文件 → 运行中的 ego 独占锁，`copyFileSync`、`cp`、PowerShell 的 `FileShare.ReadWrite` 全部失败。
- 用用户的 `user-data-dir` 再起一个带调试端口的实例 → Chromium 单例把命令行转发给已有进程后自己退出，端口永远不开。

最终改用 `ego-browser nodejs` 官方通道。附带变化：

- **删除 `lib/cdp.js`**（自建 CDP 层整个废弃）和 `lib/ws.js`（自己写的 WebSocket 客户端，用不上了）。
- **新增 `lib/ego.js`**：找 `ego-browser`、跑脚本、收事件、处理取消。
- 配置项减两项：`profileDir`、`debugPort` 不再有意义。
- 默认后台无头运行，不弹窗、不抢焦点；`/hark-login` 改为把已有标签页切到前台。
- `extractReply` 兼容 Hark 直接把 `[/DSH#<id>]` 当结尾的写法（实测 Hark 常这么干）。

### 踩到的三个 ego 通道的坑（都写在 `lib/ego.js` 注释里）

1. 脚本从 stdin 管道喂进去会随机挂死（约 1/3 概率不输出也不退出）→ 改成写临时文件，以文件句柄作 stdin。
2. `ego-browser nodejs` 的 stdout/stderr 不实时回传，要等子进程退出才一次性给出 → 边跑边收事件必须另开通道，改用事件文件 + `appendFileSync`。
3. 脚本里的 `console.log` 被路由到 stderr，不是 stdout → 两路都解析。

## 0.2.1

修掉 0.2.0 及以前遗留的一批问题：

- **致命：`inject` 写法在 cordis 4.x 下导致插件永不激活。** 原来写 `{ required: ['tools'], optional: ['commands'] }`，cordis 会把它当成 `name → config` 映射，服务名变成字符串 `"required"` 和 `"optional"`，插件的 `apply` 根本不执行。改成 `inject = ['tools']`，可选服务 `commands` 改用 `ctx.get('commands')` 运行时探测。
- 运行中途取消后不再往输入框打字：`sleep()` 现在响应 `AbortSignal`。
- 超时不再把半截回复当成功返回：抛 `HarkTimeoutError`，message 明确写「本次回复未完成，不能当作结论使用」，已收到的部分挂在 `e.partial`。
- 清理顺序修正：先结算 promise 再清理资源，避免回调在已销毁的会话上跑。
- `spawn` 失败（比如路径配错）会有明确的错误，不再静默。
- `triggerWords` 清空时工具说明不再退化成「无条件强制调用」。
- 新增 `lib/config-schema.js`，让设置面板能渲染配置表单。

## 0.2.0

- `ask_hark` 参数结构化：拆成 `mode` / `user_request` / `analysis` / `context` / `questions`，并在工具说明里强制 DSH 先自己分析再发。
- 新增 `/hark` 与 `/hark-login` 命令。

## 0.1.0

首个版本：`ask_hark` 工具，浏览器驱动 Hark 页面。
