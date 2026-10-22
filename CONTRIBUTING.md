# 贡献指南

先谢谢你愿意看这个项目。

## 最重要的一条：这个插件只支持 ego

`lib/ego.js` 是唯一的浏览器驱动层，走的是 `ego-browser nodejs` 这个官方 CLI 通道。**没有 Chrome / Edge / Firefox 的兼容代码**，因为实测下来那几条路都有硬问题（详见 README 开头）。

如果你想加别的浏览器，欢迎提 PR，但请：

1. 把新驱动做成**可选后端**，不要改掉 ego 那条路（很多人的 DSH 只装了 ego）。
2. 保持 `lib/ego.js` 的导出契约不变：

```js
// 返回可执行文件路径，找不到返回 null
findEgoBrowser(preferred: string): string | null

// 异步生成器：依次 yield 事件对象
// { ok: true, phase: 'open' }           页面已就绪
// { ok: true, phase: 'sent' }           消息已发出
// { ok: true, phase: 'poll', text: '' } 当前页面全文
// { ok: false, phase: 'focus'|'send' }  某个阶段失败（会转成对应的用户可读错误）
streamEgoScript(source, { exePath, signal, timeoutMs }): AsyncGenerator<Event>

// 跑完取最后一个事件
runEgoScript(source, opts): Promise<Event>
```

3. 必须支持 `signal` 取消：abort 时立刻停轮询、不再往页面打字、kill 掉底层进程。
4. 必须在 `npm test` 和 `npm run test:e2e` 下都通过。`test:e2e` 会用假 Hark 页面（`http://127.0.0.1:18941`）走真实链路。

## 不要改协议

`lib/protocol.js` 里定义的消息格式和结束标记是和 Hark 约定好的，**Hark 已经学会了它们**（通过首次握手那条规则消息）。改格式意味着所有用户的 Hark 都要重新学一遍，所以：

- 请求头 `[DSH#<id>] <mode>` 和结尾 `[/DSH#<id>]` 不要动。
- 结束标记 `[[DSH-END#<id>]]` 不要动。插件同时也认 `[/DSH#<id>]` 当结尾，这是容错，不是新协议。
- 如果你确实要改 `buildRulesBody()` 的内容，**必须把 `RULES_VERSION` 加 1**，这样老用户下次调用会自动重发新规则。

### 一条硬约束

`buildRulesBody()` 返回的文本里**绝对不能出现真实编号**，只能用 `<编号>` 这种占位符。因为这段文本会被拼进发给 Hark 的消息里，而 `extractReply()` 是扫整页文本找结束标记的——如果规则文本里出现了真实标记，它自己就会被判成「Hark 已经回复完了」，整个请求直接返回空。

`test/bridge-mock.test.mjs` 的最后一个用例专门盯这条。

## 代码风格

没有 linter，跟着现有代码走就行。有几条是我刻意的：

- 注释写**为什么**，不写**是什么**。踩过的坑要写清楚「试过 X，失败因为 Y」。
- 错误信息面向用户，要说清下一步怎么办（比如「请执行 /hark-url 设置地址」而不是「harkUrl is undefined」）。
- 异步取消一律用 `AbortSignal`，不要自己发明标记位。

## 跑测试

```bash
npm test          # 五个单测，不需要浏览器，秒级
npm run test:e2e  # 真实 ego 链路，约 12 秒，会在你浏览器里闪一个标签页
```

两个测试都会把 `DSH_HARK_BRIDGE_HOME` 指向临时目录。**如果你新增了会碰 `lib/store.js` 的测试，请照做**，否则会往用户真实的 `%LOCALAPPDATA%\dsh-hark-bridge\settings.json` 里写垃圾数据（我犯过这个错）。

## 提交 PR

- 一个 PR 一件事，别把重写和修 bug 混在一起。
- 说清楚改了之后「怎么验证的」。
- 涉及行为的改动请同步更新 `README.md` 和 `skills/hark-collab/SKILL.md`。
