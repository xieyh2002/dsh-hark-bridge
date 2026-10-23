# dsh-hark-bridge

> 把 **DeepSeek Harness**（DSH）接上 **Hark**：Hark 写方案 → DSH 派子代理干活 → 代码再交 Hark 审查。

DSH 遇到大需求时容易一头扎进代码里，缺少「先想清楚再动手」和「写完再审一遍」的环节。这个插件把这两步外包给 Hark：它在你正在用的浏览器里打开 Hark 对话页，替你问、替你读回复，再把结果作为工具结果交回 DSH。

---

## ⚠️ 先读这一段：只支持 / 只测试了 ego 浏览器

**本插件通过 `ego-browser nodejs` 官方通道驱动「ego lite」浏览器，除此之外的实现方式一行都没有。全部开发和测试都在 ego 上完成，没有在 Chrome、Edge、Firefox、Safari 上验证过。**

这是有意的技术选择，原因是三条死路都试过了：

- **复用你已登录的 ego。** 插件不新开浏览器进程，直接连到你正在跑的那个 ego 上操作标签页。你在 ego 里登录过的 Hark 可以直接用，不用再登一次。
- **不能在后台再造一个。** 实测过三条死路：自建 CDP 实例用的是全新 `user-data-dir`，等于一个没登录的浏览器；ego 运行中时 `Cookies` 文件被独占锁定，复制不出来（`copyFileSync`、`cp`、PowerShell 的 `FileShare.ReadWrite` 全部失败）；同一个 `user-data-dir` 也不能再起第二个带调试端口的实例（Chromium 单例会把命令行转发给已有进程然后自己退出）。
- **不能被第二个实例干扰。** 同时存在两个 ego 时，`ego-browser` 会随机连到其中一个，连到空的那个就报 `Please complete the onboarding process first`。所以插件绝不自己起浏览器。

### 如果你的 DSH 用的不是 ego

完全可以改。**把下面这段直接交给你的 AI（Claude、GPT、DSH 自带的助手都行）**，让它照着改：

```
这个插件 dsh-hark-bridge 目前只支持 ego 浏览器，因为它是通过
`ego-browser nodejs` 这个 CLI 通道去驱动页面的。我的 DSH 用的是
________（填你的浏览器 / 你的 DSH 是怎么控制浏览器的）。

请帮我把它改成用我这边可用的方式驱动浏览器。需要保留的行为：
1. 复用我已有浏览器的登录态，不要新开一个空 profile 让我重新登录 Hark。
2. 一次 ask 要能：打开/选中 Hark 对话页 → 等输入框出现 → 输入文本 → 回车发送
   → 反复读页面文本，直到出现结束标记或超时。
3. 必须支持中途取消：DSH 里中断工具调用时，要立刻停止轮询、不再往输入框打字。
4. 超时不能把半截回复当结论返回，要抛错并附上已收到的部分。
5. 后台跑，不弹窗、不抢焦点。

需要改的地方集中在 lib/ego.js（浏览器驱动层，导出 findEgoBrowser /
streamEgoScript / runEgoScript）和 lib/bridge.js 里调用它们的地方。
只要新驱动同样提供「yield {ok:true, phase:'open'|'sent'|'poll', text?} 的异步
生成器」和「一次性跑完的 runScript」，bridge 的协议逻辑可以不改。
lib/protocol.js 里的消息格式和结束标记规则也不要改，Hark 已经学会了它。
```

各浏览器的大致路子（供参考，未验证）：

| 浏览器 | 可行做法 |
| :-- | :-- |
| Chrome / Edge / Brave | 用你自己的 `user-data-dir` 起 `--remote-debugging-port`（必须先关掉在跑的那个实例），走 CDP `Runtime.evaluate` + `Input.insertText` |
| 已经开了调试端口的 Chromium | 直接连 `/json/list` 拿 `webSocketDebuggerUrl`，不必自己 spawn |
| Firefox | 走 WebDriver BiDi 或 `marionette`，不能用 CDP |
| DSH 自带的 Electron 内置浏览器 | 从主进程注入，或用 Electron 的 `webContents.debugger` |

改动之后请务必重跑 `npm test` 和 `npm run test:e2e`（后者会用假 Hark 页面走一遍真实链路）。

---

## 它做什么

| 名称 | 类型 | 说明 |
| :-- | :-- | :-- |
| `ask_hark` | 模型工具 | 你的话里出现触发词（默认：`hark`、`问 Hark`、`让 Hark`、`交给 Hark`、`@hark`）时 DSH 自动调用。参数 `mode`（plan / review / chat）、`analysis`（DSH 自己对需求的分析）、`context`（相关代码）、`questions`（要 Hark 拍板的点）、`attachments`（要一起发过去的工作区文件） |
| `/hark <内容>` | 命令 | 你直接问 Hark，回复显示在 DSH 里 |
| `/hark-url <网址>` | 命令 | 设置或查看 Hark 对话页地址；不带参数时如果 ego 里开着 Hark，会直接列出候选地址 |
| `/hark-login` | 命令 | 把 Hark 页面切到前台，首次使用在里面登录一次 |
| `/hark-diag` | 命令 | 自检：逐项检查 ego、地址、握手、锁和页面锚点，每项都给出下一步怎么办 |

工具定义会强制 DSH 先自己读项目、写分析，再把结果发给 Hark——避免它把你的原话原样甩过去。

## 方案和审查都落成 Markdown 文件

Hark 的回方案、审代码动辄几千上万字。塞进对话上下文有两个坏处：贵，而且过几轮就被挤没了。所以每次回复都会**同时写一份 Markdown 到工作区**：

```text
<工作区>/.hark/replies/20261023-120733-plan-dsh-hark-bridge-0.8-改进方案.md
```

文件名分三段：`时间戳-模式-内容`。第三段按这个顺序取：正文第一个标题 → 请求正文首行 → 请求编号。所以长方案会按它自己的标题命名（`…-review-附件卡片只认本次回复.md`），一句话的回复用你问的那句话命名（`…-chat-问一下.md`），只有两者都没有时才会出现 `…-chat-idn1voy2s.md` 这种请求编号。

文件带 YAML front matter（请求编号、模式、保存时间、发过哪些附件），正文是 Hark 回复的原文。DSH 拿到的只是「存到哪了 + 开头 1200 字预览」，要看细节自己去读文件。

**双向传文件**：

- **发给 Hark**：`ask_hark(..., attachments: ["docs/plan.md", "src/a.ts"])`。只接受工作区内的相对路径（绝对路径、越界、`.env` 这类敏感文件、超大小的会被拒并说明原因）。文件作为真正的附件上传，不是把内容粘在正文里——格式、行号、diff 都能保真。
- **看细节有更省的路子**：Hark 回复里如果挂了 `.md` 附件，插件会把**文件本身**下载到同一个目录，并按同样的规则改成可读名字（`<时间戳>-<模式>-<卡片名>.md`）。附件比气泡里的渲染文本更完整（气泡会压掉空行、吃掉 Markdown 符号），所以拿到附件就不再另存副本——那个附件路径就是这次的回复路径。聊天正文里「见附件 xxx.md」之外的补充说明仍会随返回值给模型。
- **下载与否只看页面上有没有卡片**：不看回复长短、也不猜像不像文档。Hark 答一句「收到」时压根不生成卡片，这时去翻页面只会翻到上一轮留下的旧文件——插件宁可不下，也不拿错文件。
- **只认本次回复给的卡片**：下界是「带本次结束标记的那个回复气泡」，上界是下一条用户请求（只认第一行就是 `[DSH#<编号>] <mode>` 的气泡）。所以你自己上传的 `.md` 不会被误当成 Hark 的产出，回复正文里复述请求编号也不会让插件瞎掉。找不到锚点时同样不下载，并在返回值里写明原因。
- **卡片比文字晚到时会等一会儿**：Hark 的渲染顺序是「文字气泡（结尾是结束标记）→ 文件卡片」，卡片要等文件上传完才出现。所以 plan/review 定稿后会再等 `attachGraceMs`（默认 8 秒），卡片一出现就立刻返回；chat 模式不等，保持响应速度。等到一半页面出错也不会把已经完整的回复报成失败，只记一条警告。

传不上去时不会静默丢文件：附件上传超时会**自动降级**成把文件内容贴进正文（并在返回值里注明），实在太大降不了就明确报错。

> 目录和开关都能改：`saveReplies` 关掉落盘、`replyDir` 换目录（必须在工作区内）。关掉 `saveReplies` 只是不存聊天正文，Hark 附带的文件照样会下载——两件事分开控制。

## 它写到哪些地方

插件是跑在 DSH 主进程里的 Node 代码，用原生 `fs`，**不经过 `dsh-fs-sandbox` / `dsh-bash-sandbox`**（那两个只管模型经 `ctx.fs`、`ctx.shell` 的读写）。所以它能不能写，取决于操作系统的权限，而不是会话的沙箱模式。既然如此，就把落点收在工作区里，只留两个必要例外：

| 位置 | 内容 | 说明 |
|---|---|---|
| `<工作区>/.hark/replies/` | 回复正文、Hark 附带的 `.md` | 下载直接用绝对路径写盘，不经过浏览器下载目录 |
| `<工作区>/.hark/attach/<编号>/` | 待上传文件的暂存 | 传完即删，崩溃残留超过 24 小时会被清掉 |
| `<工作区>/.hark/settings.json` | 兜底的配置覆盖层 | 只在全局层写不进去时才出现 |
| `%LOCALAPPDATA%\dsh-hark-bridge\settings.json` | harkUrl、握手记录 | 用户级偏好，换项目不用重设 |
| `%LOCALAPPDATA%\dsh-hark-bridge\bridge-<hash>.lock` | 跨进程互斥锁 | **故意放在工作区外**：它的作用是让不同工作区的会话不会同时往同一个 Hark 输入框打字，放进工作区就等于没有锁 |
| `%TEMP%\dsh-hark-ego-*` | ego 脚本与事件文件 | 平台临时区域，用完即删 |

如果部署方只给工作区写权限（全局目录写不进去），配置覆盖层会自动落到 `<工作区>/.hark/settings.json`，读取时优先于全局层——功能不受影响，只是这份配置跟着项目走。

锁文件也一样会回落，顺序是：指定目录 → `%LOCALAPPDATA%` → `%TEMP%\dsh-hark-bridge` → `<工作区>/.hark`。每级都真的试写一次才采用，所以「目录存在但不可写」这种情况也能正确降级。落到最后一级时，跨工作区互斥会失效（两个不同项目仍可能同时给 Hark 发消息），但同一个项目内的并发照样挡住。

锁按 Hark 地址分开（`bridge-<sha256(网址)前8位>.lock`）：连两个不同 Hark 项目的会话互不排队，因为它们的语义不是「整台机器只能有一个人用 Hark」，而是「同一个对话框只有一个人在打字」。

## 环境要求

- **DSH** ≥ `0.2.0-rc.2`
- **ego lite**（提供 `ego-browser` 命令）已安装，并且**正在运行**
- Node.js ≥ 20
- Windows / macOS / Linux 均可（`findEgoBrowser` 里写了三个平台的常见路径；实际只在 Windows 上测过）

## 安装

```bash
git clone https://github.com/xieyh2002/dsh-hark-bridge.git
cd dsh-hark-bridge
npm install
```

然后在 DSH 里：

1. 「插件」→「安装插件」，填**本目录的绝对路径**
2. 重启 DSH

装完 `ask_hark` 工具和 `/hark*` 命令就都在了。

## 首次使用

先只输入 `/hark-url`（不带参数）。如果你本来就在 ego 里开着 Hark，插件会扫一遍已打开的标签页，把像 Hark 对话页的地址列出来让你挑：

```text
还没有设置 Hark 地址，但在 ego 里发现了这些 Hark 页面：
  https://hark.com/project/xxxx（DSH 协作）

如果是其中某一个，执行 /hark-url <上面那个完整地址> 采用它。
```

没有候选就手动设：

```text
/hark-url https://hark.com/project/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

地址从哪来：在 Hark 里建一个专门的项目（比如叫「DSH 协作」），打开对话页，复制浏览器地址栏的整条 URL。**要确认复制的是对话页，不是项目列表页**——复制错的表现是「连上了但发消息没反应」，比没配更难查。

```text
/hark-login
```

Hark 页面会在你的 ego 里切到前台。没登录就在那儿登录一次——登录态就是你 ego 自己的登录态，插件不存任何密码或 cookie。

```text
/hark-diag
```

逐项自检，全绿就说明配置没问题。之后任何时候出问题，先跑它：

```text
✅ ego-browser：C:\Program Files\Citro Labs\ego lite\Application\0.6.0.16\ego-browser.exe
✅ harkUrl：https://hark.com/project/xxxx（来源：/hark-url）
•  握手：未握手或规则已升级（记录 v无，当前 v2）
   → 下次请求会自动握手一次，多花一轮消息；不用手动做
✅ 锁：没有别的会话在占用
✅ 消息气泡：命中 6 个（[data-testid=message-bubble]）
✅ 输入框：命中 1 个（textarea, [contenteditable="true"], …）
✅ 发送按钮：aria-label="Send message"（界面语言 en）
```

每项后面都跟着「怎么办」。`•` 是「查到了但不构成错误」——比如还没握手、页面上暂时没有附件卡片。

```text
/hark ping
```

通了就说明链路正常。

## 用法

日常就这么说话，DSH 会自己判断要不要找 Hark：

> 让 Hark 规划一下：给 restart-hotkey 加一个重启前自动保存会话的功能

> 帮我审一下这次的改动 @hark

或者直接：

```text
/hark 这段正则为什么匹配不到中文
```

**推荐的大需求流程**（把 `skills/hark-collab` 加进 DSH 的 `customSkillDirs` 后会自动按这个走）：

1. DSH 自己读项目、写分析 → `ask_hark(mode="plan")` 要方案
2. 按方案拆任务，并行派子代理实现
3. 跑测试 → `ask_hark(mode="review")`，`context` 放 `git diff` 和测试结果
4. 按「必须修改」逐条改，再 review，直到通过

## 协议

发出的消息长这样：

```text
[DSH#a1b2c3d4e] plan
## 用户原话
...
## DSH 的分析
...
## 需要 Hark 决定的问题
...
[/DSH#a1b2c3d4e]
```

Hark 回复完，在最后一行写 `[[DSH-END#a1b2c3d4e]]`，插件就把中间的文字作为工具结果拿回来。

> **只认 `[[DSH-END#<编号>]]`。** 早期版本把 `[/DSH#<编号>]` 也当结束标记，结果 Hark 一旦在回复里引用请求、或代码块里恰好有一行以它结尾，后半截回复就被丢掉，上层却拿到一个看起来完整的结论——这是最危险的失败模式。现在 `[/DSH#<编号>]` 只用来定位回复的起点，不再代表结束。

### 首次会自动教一遍规则

Hark 不会天生知道要写什么结束标记。所以**每个 Hark 地址第一次被调用**时，插件先单独发一条规则说明过去：

- 消息长什么样（请求头 / 正文 / 结尾标记）
- 回复末尾必须单独一行写 `[[DSH-END#<同一个编号>]]`
- 编号必须一致，不能改、不能省
- 标记只写一次，写在正文中间无效
- 标记之后不要再写内容

Hark 回一句「规则已收到」就算握手完成，记在 `settings.json` 的 `handshakes` 里，之后同一个地址不再重复发。换了新的 Hark 页面地址会重新握手一次。

实测 Hark 学得很快，握手后就会照规矩写标记：

```text
现在请回复一行「规则已收到」，并附上本次的结束标记。之后我们开始正式协作。
[/DSH#fwvn0m3mo]

规则已收到
[[DSH-END#fwvn0m3mo]]        ← 握手这轮，Hark 学会了
```

容错设计：

- **握手失败不挡正式请求。** Hark 可能早就学会了；真正有没有说上话由正式请求判定，报错更准确。但「找不到输入框」会立刻上抛 `HarkLoginError`——那说明没登录或地址不对，继续等下去只是白等。
- **每条请求都自带格式说明。** 不只靠首次握手：每条消息末尾的固定提示行都写明「回复最后请单独一行写 `[[DSH-END#<编号>]]`」，对话上下文被压缩、握手没成功也不会退化成超时。
- **结束标记必须在行尾。** 标记后面还有字（例如「写法是 `[[DSH-END#a1b2c3d4e]]` 这样」）不算结束；但也不要求独占整行——Hark 页面按 Markdown 渲染，单个换行会并成空格。
- **规则文本里绝不出现真实编号。** 只用 `<编号>` 占位，否则规则自己就会被判成「Hark 已经回复完了」。有专门的测试盯这条。

## 配置

`harkUrl` 用 `/hark-url` 设，值存在 `%LOCALAPPDATA%\dsh-hark-bridge\settings.json`（Linux/macOS 是 `~/.dsh-hark-bridge/settings.json`）；全局层写不进去时落到 `<工作区>/.hark/settings.json`，读取时工作区层优先。两条路都优先于 cordis 配置。

其余项改 `cordis.yml` 里本插件的 `config`（或者 `cordis.patch.yml`）：

| 配置项 | 默认 | 说明 |
| :-- | :-- | :-- |
| `harkUrl` | 空（必填） | Hark 对话页地址，建议用 `/hark-url` 设置 |
| `triggerWords` | `hark` 等 5 个 | 触发词，可以加「出方案」「审一下」之类 |
| `browserPath` | 自动查找 | ego-browser 的路径，装到非标准位置时手动指定 |
| `inputSelector` | 自动识别 | Hark 页面改版后找不到输入框时手动指定 |
| `sendSelector` | 自动识别 | 回车发不出去时，指定发送按钮的选择器 |
| `timeoutMin` | 20（1–120） | 等回复的最长分钟数 |
| `loginWaitSec` | 120（5–600） | 等登录 / 输入框出现的最长秒数 |
| `pollMs` | 2000（200–30000） | 轮询页面文本的间隔毫秒 |
| `settleMs` | 3000（0–30000） | 看到结束标记后再等多久，让流式输出稳定下来 |
| `maxChars` | 60000（1000–400000） | 单条消息字符上限，超了会被拒，请拆开发 |
| `saveReplies` | `true` | 把回复的**聊天正文**存成 Markdown 文件（不影响 Hark 附带的文件下载） |
| `replyDir` | 空（用 `.hark/replies`） | 回复保存目录，必须在工作区内 |
| `fetchAttachment` | `true` | Hark 附带 `.md` 时下载文件本身（内容比气泡文本完整） |
| `markdownMinChars` | 1200（0–200000） | 只有聊天正文、没拿到附件时，正文超过这么多字符才另存一份；一句话的回答直接用正文。设 0 表示总是存 |
| `attachTimeoutSec` | 60（5–300） | 等附件上传就绪的秒数 |
| `attachGraceMs` | 8000（0–60000） | 回复结束后再等附件卡片多久（毫秒）。Hark 的文件卡片通常比文字晚一两秒出现，plan/review 会在这段宽限期里等它；chat 不等 |
| `fileInputSelector` | 自动识别 | 上传用的 file input 选择器 |
| `attachmentSelector` | 自动识别 | 识别「Hark 附了 .md」的卡片选择器 |
| `maxFileBytes` | 2 MB（1 KB–64 MB） | 单个附件上限 |
| `maxTotalBytes` | 10 MB（1 KB–256 MB） | 一次请求的附件总量上限 |
| `maxFiles` | 20（1–100） | 一次最多几个附件 |
| `autoAttachOverflow` | `true` | 正文超 `maxChars` 时自动把内容转成附件发 |

数值项都有上下界：手改 `settings.json` 写进 `"timeoutMin": "あ"` 这种内容时会被夹回合法值。否则 `timeoutMin * 60000` 是 `NaN`，定时器永远不触发，请求会挂死。

## 工作原理

```text
DSH ──ask──▶ HarkBridge ──spawn──▶ ego-browser nodejs ──▶ 你的 ego 浏览器
                     │                                        │
                     │  ◀── 事件文件（appendFileSync）─────────┘
                     └── 解析结束标记 ──▶ 工具结果
```

一次 `ask` = 一个 `ego-browser nodejs` 子进程。脚本里跑完「选中标签页 → 等输入框 → 输入 → 回车 → 无限轮询页面文本」，父进程读事件文件判定结束标记，拿到了或取消了就 kill 子进程。

三个踩过的坑，都写在 `lib/ego.js` 的注释里：

1. **脚本从 stdin 管道喂进去会随机挂死**（约 1/3 概率不输出也不退出）→ 改成写临时文件，以文件句柄作 stdin。
2. **`ego-browser nodejs` 的 stdout/stderr 不实时回传**，要等子进程退出才一次性给出 → 需要边跑边收事件必须另开通道，用事件文件，`appendFileSync` 一行一条，实测实时可见。
3. **脚本里的 `console.log` 被路由到 stderr** → 两路都解析。

事件文件是按**字节增量**读的：每轮只 `readSync` 新写入的字节，并且只消费到最后一个换行（半行留到下一轮，避免把多字节字符切两半）。早先每轮 `readFileSync` 整个文件再切，页面越长越慢，是 O(n²)。

脚本只在尾部文本有变化时才回传正文，没变化就发一条不带正文的心跳行，所以事件文件不会随对话长度指数增长。

## 已知限制

- **强依赖 ego。** 见开头那段。换浏览器要改 `lib/ego.js`。
- **靠读网页文字工作。** 页面锚点集中在 `lib/selectors.js`，文案类锚点中英文双匹配，结构锚点优先用 `data-testid`。Hark 真改版时，先用 `/hark-diag` 看是哪一项失效，再用 `inputSelector` / `sendSelector` / `attachmentSelector` 临时绕过。
- **串行排队 + 跨进程锁。** 同一个页面不能两个请求同时打字，所以一次只发一条。多个 DSH 会话同时用会排队（锁文件按 Hark 地址分开：`bridge-<hash>.lock`；持锁期间每 60 秒写一次心跳，判断残留看「持有者进程是否还活着」**或**「心跳是否停摆超过 3 个周期」——后者是为了防 Windows pid 复用导致的永久死锁；等待上限 2 分钟）。释放时只删自己的锁——早先无条件删，锁被接管后原进程会把别人的锁删掉，第三个会话就能挤进来。
- **排队中也能取消。** 还没轮到就按停止，请求立刻结束，不会排在前面那个请求后面白等。
- **超时不返回半截结论。** 默认 20 分钟，超了抛 `HarkTimeoutError`，错误里附上已收到的部分——但那可能被截断，不能当方案或审查通过的依据。需要更长回复就调大 `timeoutMin`，或者把需求拆小。
- **页面丢了会早报。** 发出去之后整页文本变空超过 60 秒，会报「Hark 页面忽然读不到内容了」，而不是干等到 `timeoutMin`。
- **每次请求在 ego 里新建或复用一个标签页**（TaskSpace 名 `hark-bridge`），跑完不关，下次接着用。
- **需要 ego 正在运行。** 没启动会报「ego 还没完成初始化引导」或连接失败。

## 开发与测试

```bash
npm test          # 十四个单测，不需要浏览器，秒级跑完
npm run test:e2e  # 真实链路：起一个假 Hark 页面，用真 ego 走一遍完整流程
npm run fixture   # 重新抓一份真实页面结构（脱敏后存 test/fixtures/）
```

`npm test` 覆盖：协议拼装与结束标记识别（含 `[/DSH#id]` 不能当结束、正文引用标记、重复渲染、多标记取最后一个）、插件 wiring（`inject` 必须是数组，cordis 4.x 的坑）、配置 schema 兜底与数值夹取、ego 驱动层（事件实时性、跨 UTF-8 边界、取消、脚本自毁、陈旧临时目录清理）、跨进程锁（互斥、残留回收、心跳防误抢、只删自己的锁、不同地址各自排队）与排队取消、附件校验（越界、敏感文件、去重、超限）、回复落盘（文件名规范化、同名加后缀、front matter、中文路径）、页面锚点（中英文界面、卡片名前后缀、`data-testid` 优先）、自检命令、握手逻辑（首次发 / 只发一次 / 换地址重发 / 失败不阻断 / 规则文本不撞标记）、取消与超时语义、工具层接线（落盘路径、预览截断、越界降级、短回复不落盘、`/hark` 命令同样落盘）、文件通道门控（页面有卡片才下载，一句话直接读正文，超长正文转附件）。

### 为什么有一份真实页面的快照

`test/fixtures/hark-conversation.html` 是从真 Hark 页面上抓下来的 DOM 结构（正文全部换成了占位，文件名换成了 `fixture-1.md` 这类假名，项目 id 换成了定长假 uuid）。`test/fixture.test.mjs` 用 jsdom 把它装起来，让页面锚点、卡片抠名、`ATTACH_READY` 这些真实页面表达式直接在它上面跑。

这么做是因为：`test/e2e-live.mjs` 里的假 Hark 页面是照**我们对 Hark 的理解**写的，Hark 改一次前端，CI 依然全绿，而真机上插件已经瞎了。有真实结构在手，改版就能立刻红。

它不是摆设：0.8.4 把夹具落地，0.8.6 就靠它抓到一个真 bug——带附件的请求气泡里，Hark 把文件 chip 排在文字**前面**，气泡首行成了文件名而不是 `[DSH#编号]`，「下一条请求」这个上界因此失效，最坏会把用户自己刚上传的 `README.md` 当成 Hark 的回复下载回来。这种结构假页面里没有，只有真页面有。

Hark 前端变了之后重新抓一份：

```bash
npm run fixture                       # 覆盖 hark-conversation.html
npm run fixture -- english-ui.html    # 或者另存一个（比如切到英文界面再抓）
```

抓之前得让 ego 里开着那个 Hark 页面（插件自己会去找合适的标签页）。**抓完请先看一眼**：脱敏只保留结构和协议标记，正文一律是「正文占位」，文件名是 `fixture-N.*`，请求编号是 `fixture1`、`fixture2`……（不同编号映射成不同假编号——统一映射成一个会把「哪条回复属于哪条请求」抹掉，夹具就在测一个不存在的场景）。如果看到真实内容说明脱敏漏了，别往外提。

`npm run test:e2e` 会在你的 ego 里临时开一个标签页（`http://127.0.0.1:18941` 的假 Hark 页面），20 项断言，约 20 秒，跑完自己关掉。用的是你真在跑的 ego，所以能看到标签页一闪而过。

`npm test` 和 `npm run test:e2e` 都会把 `DSH_HARK_BRIDGE_HOME` 指向临时目录，不会污染你真实的 `settings.json`。

代码结构：

```text
lib/index.js         插件入口：注册 ask_hark 工具与 /hark* 命令
lib/bridge.js        HarkBridge：排队、握手、发消息、等回复、上传附件、下载附件、自检
lib/protocol.js      消息格式、结束标记、extractReply
lib/ego.js           浏览器驱动层：找 ego-browser、跑脚本、收事件、杀进程组
lib/attach.js        上行：校验工作区路径、暂存、命名、超限处理
lib/reply-store.js   下行：回复落盘（目录解析、文件名规范化、front matter）
lib/config-schema.js 配置 schema（schemastery，加载不到会退回内置实现）
lib/store.js         配置覆盖层（工作区优先，/hark-url 与握手记录）
lib/selectors.js     页面锚点与文案（中英文双匹配，改版时只动这里）
skills/hark-collab/  推荐给 DSH 的协作流程
scripts/capture-fixture.mjs  抓真实页面结构并存成测试夹具
```

## License

MIT
