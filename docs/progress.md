# Vendor 维护与传输记录

## Vendor 校验

`vendor/openclaw-weixin.manifest.json` 记录随仓库交付的传输层文件摘要。运行 `pnpm vendor` 比对新增、删除和修改；文本的 CRLF/LF 差异不应产生内容漂移。

发现漂移先检查实际差异和来源。只有确认升级或有意补丁后，才能运行 `node bin/vendor-manifest.mjs --write` 重录摘要；不能靠重录消除未解释的失败。

有意修改 vendor 时在本文件追加记录：日期、上游版本与来源、修改文件、原因、测试证据及仍未验证的行为。代码、记录与 manifest 必须放在同一个 PR。本轮行尾兼容修复未修改 vendor 内容或重录 manifest。

## 语音发送的历史限制

`src/channel.js` 和 `src/index.js` 保留了历史观察：某些 iLink 语音发送请求返回成功，但微信端未送达，因此 Channel 的 `voice` 能力仍标为 false。原始两次测试日志未随本仓库提供，这不是本轮实测结论，也不能据此承诺当前所有账号都有相同表现。

如要改变这一能力声明，应先用独立测试账号验证接收端真实收到语音，并记录日期、协议版本、格式及结果；只验证 HTTP 成功或 `ret=0` 不够。
