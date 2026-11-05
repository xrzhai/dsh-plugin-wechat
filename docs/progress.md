# Vendor 维护与传输记录

## Vendor 校验

`vendor/openclaw-weixin.manifest.json` 记录随仓库交付的传输层文件摘要。运行 `pnpm vendor` 比对新增、删除和修改；文本的 CRLF/LF 差异不应产生内容漂移。

发现漂移先检查实际差异和来源。只有确认升级或有意补丁后，才能运行 `node bin/vendor-manifest.mjs --write` 重录摘要；不能靠重录消除未解释的失败。

有意修改 vendor 时在本文件追加记录：日期、上游版本与来源、修改文件、原因、测试证据及仍未验证的行为。代码、记录与 manifest 必须放在同一个 PR。本轮行尾兼容修复未修改 vendor 内容或重录 manifest。

## 2026-11-05 · issue #59 发送失败边界

- 上游来源：`@tencent-weixin/openclaw-weixin@2.4.10` 的
  `dist/src/api/api.js`。复查确认 `sendMessage` 只在成功解析响应后检查
  `resp.ret`；非零 `ret` 抛普通 `Error`，而 `apiPostFetch` 的 fetch、HTTP、
  解析失败发生在这一判断之前，不能从异常文本可靠判断是否已提交。
- 有意修改：`vendor/openclaw-weixin/api/api.js` 将非零 `ret` 改为结构化的
  `SendMessageRejectedError`，保留 `ret`、`errmsg`，并标记
  `sendOutcome: "rejected"`。HTTP、网络和解析错误不附加该标记。
- 调用方规则：只有 typed rejection 才允许语音失败后安全回退文件；caption
  或 voice 的 HTTP/网络结果不确定时不回退，避免重复投递。
- 主通道修复：`channel.sendMedia({ text })` 会经真实 transport 作为 caption
  发出；transport 同时接受直接调用使用的 `caption` 别名。
- 测试证据：voice 成功、caption 前失败、caption 后明确拒绝、caption/voice
  网络歧义、伪造 rejection 文本、vendor HTTP/网络错误，以及 channel 到
  transport 的端到端标题传递。
- 仍未验证：`ret=0` 只证明协议接口接受请求，不证明微信客户端已送达；网络
  歧义场景只避免自动重发，不做服务端投递状态推断。

## 语音发送的历史限制

`src/channel.js` 和 `src/index.js` 保留了历史观察：某些 iLink 语音发送请求返回成功，但微信端未送达，因此 Channel 的 `voice` 能力仍标为 false。原始两次测试日志未随本仓库提供，这不是本轮实测结论，也不能据此承诺当前所有账号都有相同表现。

如要改变这一能力声明，应先用独立测试账号验证接收端真实收到语音，并记录日期、协议版本、格式及结果；只验证 HTTP 成功或 `ret=0` 不够。
