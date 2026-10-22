# 更新记录

版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
