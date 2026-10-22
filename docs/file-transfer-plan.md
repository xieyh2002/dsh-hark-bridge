# 双向文件传递：实施方案（Hark 方案 + 本机实测补充）

> 来源：Hark 于 2026-10-22 给出的方案（原文件由 Hark 以 `.md` 附件形式附带，插件已实测下载成功）
> 基线：v0.4.0 ｜ 本文件是 A/B/C/D 四个子任务的接口契约来源

## 0. 结论先行

- **下行（Hark → DSH）**：第一期由插件把 reply 自己写成 `.hark/replies/<时间戳>-<mode>-<id>.md`。
  innerText 会丢代码围栏和标题层级，所以 Hark 附带的 `.md` 附件比读页面文本更保真。
- **上行（DSH → Hark）**：顺序是 `setInputFiles` → 等附件就绪 → `insertText` → Enter。
  文件先复制到本次 ask 的临时目录（staging），目的是快照和避免重名，不是为了转 ASCII。
- **安全**：附件路径必须限制在工作区内，并加敏感文件黑名单。这是新增的最大风险点：模型可以传任意路径。
- **maxChars**：正文保留硬上限。超限且附件可用时，把 `context` 段自动转成附件；转不了就报错。

## 0.1 本机实测补充（推翻了 Hark 方案里的两处判断）

Hark 方案把「真下载」放到第二期、并担心要多一轮往返。本机实测证明**不需要推迟、也不增加往返**：

| 项 | 实测结果 |
| :-- | :-- |
| Hark 是否会在同一条回复里附带 `.md` | **会**。实测那条 plan 回复就附了 `dsh-hark-bridge-file-transfer-plan.md` |
| 附件卡片 DOM | `div[data-message-id]` → `button[aria-label="打开 <文件名>[ 的预览]"]`，**必须滚动到底部才渲染** |
| 预览弹窗 | `div[role=dialog]`，内含 `a[download]`，href 形如 `/api/files/<projectId>/artifact?key=sessions%2F...%2Fuploads%2F...%2F<文件名>` |
| 下载方式 | `page.fetch(href, { saveAs })` **直接成功**，拿到 12706 字节完整 Markdown（标题层级、代码围栏、引用块全部保真），比 innerText 质量高一档 |
| 是否触发浏览器下载事件 | 不需要走 `waitForEvent('download')`；`a[download]` 的 href 直接 fetch 即可，带页面 cookie |

结论：下行做成「优先抓附件保真副本，抓不到再用 innerText 写盘」，两者都写，附件版命名 `<id>.hark.md`。

## 1. 逐条拍板

### Q1 下行落盘

第一期（必做）：

- 文件名：`.hark/replies/<YYYYMMDD-HHmmss>-<mode>-<id>.md`。
- 开头写 YAML front matter：`id`、`mode`、`harkUrl`、时间、附件清单、`source: innertext`（附件版写 `source: attachment`）。
- 写入方式：先写 tmp 再 rename，保证原子性；从不覆盖已有文件（同名加 `-2`）。
- 写盘失败不让整个 ask 失败（reply 已拿到），但工具返回值必须带一行 `⚠️ 回复未能保存为文件：<原因>`。

第二期（本次一并实现，因为实测发现成本几乎为零）：

- 配置 `fetchAttachment`，默认 `true`。
- `done` 之后在最后一条 Hark 气泡里找 md 附件卡片，取 `a[download]` 的 href，`page.fetch(href, { saveAs })` 存为 `<id>.hark.md`。
- 失败只追加警告，innerText 版始终保留。
- 不在请求消息里额外要求 Hark 附 md（Hark 自己会附），所以不增加往返、不改 RULES_VERSION 之外的协议。

### Q2 中文 / 空格路径

- 路径通过脚本文件以 UTF-8 JSON 字面量传给 CDP `DOM.setFileInputFiles`，不经过命令行 argv，无编码问题。
- 仍然统一复制到 staging（本次 ask 的临时目录下的 `upload/`），理由三条：
  1. **快照**：子代理可能还在写源文件，复制后上传的是确定版本；
  2. **重名**：两个 `index.js` 会撞名，staging 时把相对路径扁平化成 `lib__index.js`；
  3. **清理**：随临时目录一起删。
- staging 保留原始中文文件名。e2e 加用例：文件名含中文和空格、目录也含中文，断言上传成功。

### Q3 时序与「就绪」信号

顺序：**清理残留附件 → setInputFiles → 等就绪 → insertText → Enter → 发送后校验**。

- **先附件、后打字**：输入框为空时 send-button 的 `aria-label` 从「开始听写」变「发送消息」可作为附件已挂上的信号。先打字这个信号就失效了。
- 单靠 label 不够（只说明「至少挂上一个」），就绪条件取三项的「与」，轮询上限 `attachTimeoutSec`（默认 60）：
  1. composer 区域内出现含文件名的元素，数量 ≥ n；
  2. composer 内没有 `[role=progressbar]` 或 `[aria-busy=true]`；
  3. send-button 未 disabled 且 label 为「发送消息」。
  三项连续两次轮询都满足才算就绪。
- **清理残留**：上次失败的 ask 可能在输入框留下附件 chip，下次发送会一起带出去。每次 ask 开始时有附件就 reload 页面。
- **发送后校验**：轮询到 footTag 时检查用户气泡里是否含每个 uploadName，缺失发 `{phase:'attach-missing', names}`。
- **协议兜底**：请求说明行加一句「若本条带附件，请在回复第一行写：已收到附件：a, b」。父进程比对，不一致就在返回值加警告。这个检查不依赖 UI 细节，最稳。

失败分支：

| 时机 | 处理 |
| :-- | :-- |
| 就绪超时（发送前） | 不发送；清掉 chip；若附件总量 ≤ maxChars，降级为贴正文并注明 `attachMode: inline`；否则抛 `HarkAttachError` |
| 发送后校验缺失 | 消息已发出，不重发（避免重复请求），等回复，返回值带警告 |
| Hark 第一行清单不符 | 返回值带警告，列出缺失文件 |

### Q4 落盘路径

- 插件固定默认值，配置可覆盖，**调用方不能传**（参数越少，模型乱写可能越小）。
  - 配置 `replyDir`，默认 `.hark/replies`，相对工作区根目录。
  - 工作区根目录优先取 DSH exec 上下文里的 cwd/workspace，取不到用 `process.cwd()`。
- 并行安全：文件名带唯一 id，跨进程锁本就串行，不会撞名；不写 `latest.md` 这类共享文件；`mkdirSync(recursive)` 幂等。
- 首次创建 `.hark/` 时提示用户加进 `.gitignore`，不自动改。

### Q5 maxChars 与附件

- 保留 `maxChars` 作为**消息正文**硬上限（输入框太长打字慢、易错）。
- 新增 `autoAttachOverflow`，默认 true：正文超限时把 `context` 段写成 `context.md` 放进 staging 作为附件，正文改写为「见附件 context.md」。转换后仍超限或附件不可用则照旧报错。
- 新增附件上限：`maxFileBytes`（默认 2MB）、`maxTotalBytes`（默认 10MB）、`maxFiles`（默认 20）。

## 2. 安全约束（必须做）

模型可以把**任意路径**传给 `attachments`，等于给了一个「把本机文件发到第三方」的通道。

- `path.resolve(root, p)` 后 `realpathSync` 解析符号链接，结果必须仍在工作区根目录内，否则拒绝。
- 默认黑名单（glob）：`.env*`、`*.pem`、`*.key`、`id_rsa*`、`*.pfx`、`.git/**`、`node_modules/**`、`**/settings.json`。可在配置里追加。
- 只接受普通文件。目录直接拒绝，不自动展开。
- 返回值列出实际上传清单（相对路径 + 字节数），方便用户审计。

## 3. 接口契约（开工前冻结）

```js
// lib/attach.js —— 子代理 A
export class AttachError extends Error { name = 'HarkAttachError' }
export function prepareAttachments(paths, {
  workspaceRoot, stageDir, maxFiles, maxFileBytes, maxTotalBytes, deny = [],
}) /* → { files: [{ rel, abs, staged, uploadName, bytes, sha256 }], totalBytes }
     违规直接 throw AttachError */
export function manifestSection(files) /* → string，「## 附件清单」Markdown 段 */
export function parseAckLine(reply) /* → string[] | null，解析「已收到附件：…」 */

// lib/reply-store.js —— 子代理 B
export function resolveReplyDir({ workspaceRoot, replyDir }) /* → abs */
export function saveReply({ dir, id, mode, reply, meta, now = new Date() })
  /* → { abs, rel }；tmp+rename，不覆盖，同名加 -2 */

// lib/bridge.js —— 子代理 C
ask(mode, body, { signal, attachments /* prepareAttachments().files */ })
  /* → { id, done, reply, attachMode: 'none'|'upload'|'inline',
        attached: string[], warnings: string[], attachmentReply?: string } */
```

## 4. 任务拆分（写作用域互不重叠）

### 子代理 A：附件准备（纯 Node，无浏览器）
- 写作用域：新增 `lib/attach.js`、`test/attach.test.mjs`
- 内容：路径校验（工作区边界、realpath、黑名单、普通文件）、大小限制、staging 复制、扁平化重名、sha256、清单段、确认行解析
- 测试要点：`..` 越界、指向外部的 symlink、`.env` 被拒、中文和空格文件名、重名扁平化、超限报错、Windows 反斜杠路径

### 子代理 B：回复落盘（纯 Node）
- 写作用域：新增 `lib/reply-store.js`、`test/reply-store.test.mjs`
- 内容：目录解析、文件命名、front matter、原子写入、不覆盖、错误对象
- 测试要点：目录不存在自动创建、并发写 10 个不同 id、同 id 第二次写入加 `-2`、只读目录报错、中文工作区路径

### 子代理 C：页面侧上传与附件下载（浏览器，最难）
- 写作用域：`lib/bridge.js`（只改 buildAskScript 与 `#ask`）、`test/bridge-mock.test.mjs`、`test/e2e-live.mjs`
- 内容：有附件时 reload 并清残留 chip；`setInputFiles`；就绪轮询（三条件、连续两次）；打字发送；发送后校验 `attach-missing`；降级 inline 与 warnings；**附件下载**（`done` 后滚到底 → 找 `button[aria-label*=".md"]` → 点开 `div[role=dialog]` → 取 `a[download]` href → `page.fetch(href,{saveAs})`）
- 假页面需要模拟：隐藏 file input；选中文件后 1–2 秒才出现 chip 且期间 `aria-busy`；send-button 的 label 切换；用户气泡显示文件名；回复后的 md 附件卡片 + 预览 dialog + `a[download]`
- e2e 新增：中文文件名上传、就绪超时降级、残留 chip 清理、从假页面下载 md 附件

### 子代理 D：接线与文档（集成，最后做）
- 写作用域：`lib/index.js`、`lib/protocol.js`（说明行与清单段）、`lib/config-schema.js`、`test/plugin-wiring.test.mjs`、`test/protocol.test.mjs`、`test/config-schema.test.mjs`、`README.md`、`CHANGELOG.md`
- 内容：`ask_hark` 新增 `attachments?: string[]`；返回值改为「回复正文（超 `inlineMaxChars` 默认 20000 时截断并注明）+ `📄 完整回复：<rel>` + 附件清单 + warnings」；`autoAttachOverflow`；新增配置项 `replyDir`、`inlineMaxChars`、`attachTimeoutSec`、`maxFiles`、`maxFileBytes`、`maxTotalBytes`、`attachDeny`、`fileInputSelector`、`attachmentChipSelector`、`fetchAttachment`；说明行加「已收到附件」要求（只用占位写法）
- 约束：`extractReply` 一行不动；`RULES_VERSION` 加 1

### 依赖顺序

```
冻结契约（已完成，即本文件）
   ├─ A ─┐
   ├─ B ─┼─→ D（接线）→ 全量 npm test + e2e → 用新功能把 diff 传回 Hark review
   └─ C ─┘
```

A、B、C 完全并行。C 只依赖 A 的 `files` 结构，测试时用手写假数据。

## 5. 验收清单

1. `ask_hark` 返回值包含 `.hark/replies/...md`，文件内容与 reply 一致（含 front matter）
2. 新增 `attachments` 参数，假页面和真实 Hark 各上传成功一次（文件名含中文）
3. 以下情况必须有显式警告或报错：就绪超时、发送后校验缺失、确认行不符、写盘失败、越界路径、黑名单命中
4. 原有 7 个单测 + 新增 2 个单测文件 + e2e 全绿；`extractReply` 的 diff 为空
5. Windows 11 本机跑通 e2e；CI 三平台 × 两个 Node 版本全绿
