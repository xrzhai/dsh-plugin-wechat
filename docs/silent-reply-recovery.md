# 同一回合末尾静默覆盖正文：最小修复

Related #32。本修复不合并 PR、不关闭 issue、不部署；云端回归不能替代真机验收。

## 已确认机制

DSH 的 turn 不等于一次模型调用。一个 step 已生成完整答复后，如果 next-step inbox 又进入通知，宿主仍可在同一 turn 继续下一 step。网关原先只保留该 turn 最后一条文本，后续纯 `[SILENT]` 会覆盖先前正文。

契约依据为上游 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`（agent-loop 0.2.2-rc.1）的实际源码：

- [turn/step 生命周期与正常无工具答复](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts#L326-L400)，[模型结算与工具调用判断](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts#L499-L597)。
- [assistant/message、interrupted 和 assistant/attempt 的定义](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/types.ts#L339-L363)。attempt 是失败/重试等未进入正式消息的记录，不能当作终稿。
- [子代理退出通知在父会话运行时通过 steer 进入](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/manager.ts#L1108-L1123)。

## 范围

仅当 `turn/end.reason.kind === completed` 且最后文本完全等于 `[SILENT]`（忽略外围空白和大小写）时尝试恢复。同一 turn 内选择最近一条非静默正式消息，不拼接所有消息，不跨 turn 查找。

候选正文及后续静默消息必须满足：

- 具有匹配的 turn/step、完整 step/start 和 step/end；该 step 仅有一个 assistant/message，且为 append、model 来源。
- 无 interrupted 标记，stream 明确以 finish(stop) 结束；内容及 stream 不携带工具调用，step 内没有工具事件或 assistant/attempt。
- 使用正式 message.content 的文本；若 stream 同时带文本，两者必须一致。reasoning、工具参数和工具结果不会进入恢复文本。
- 不越过后续真人新指令、工具执行、失败尝试或 surface 替换。

普通回复、`readAssistantReply`、混合正文与标记、其他静默标记、原有发送/游标/outbox 路径不变。尤其是原有“以 `[SILENT]` 开头的混合正文会被抑制”不在本次最小修复范围内；本 PR 不宣称解决 issue 中所有描述。

2026-11-05 补充修复：普通回复与超时补发此前绕过主动推送的静默过滤，可能直接发出纯 `[SILENT]`。现由共同的 `sendChunked` 入口在分段、出站日志及失败入队之前拦截整条纯标记（忽略大小写和外围空白）。此入口不删改含实质正文的混合文本，不改变上述主动推送的历史规则，也不清理已存在的旧 outbox 记录。`test/outbound.test.js` 覆盖发送失败不入队、后续正文正常送达及正文提及标记的情况。

只有完整纯静默的回合仍不发送。成功回调后推进该 turn 游标，失败仍由既有逻辑保留游标重试。新增日志仅记录 sessionId、正文 seq 与 turn 结束 seq，不记录正文。回调成功可能表示进入 outbox，并不等于微信手机已收到。

## 验证和限制

新增 `test/spontaneous-silent.test.js` 使用真实 AgentBridge、合成宿主事件和假发送回调；测试预加载隔离 HOME/state 并禁止真实网络。运行：

```sh
npm test
npm run check
```

覆盖同回合恢复、最新正文选择、重复轮询、失败重试、多个 turn 部分成功后的重试，以及工具/attempt/中断/截断/未知协议/真人纠正/已消费游标的负例。已有 #28 多 turn 回归保留。

没有运行真实宿主模型、微信或 Windows；没有修改 profile。未取得原现场 session 事件，因而这是对已确认机制的契约回归，不是声称已真机复现现场。缺少 step、finish、正式消息字段的旧事件会保持原有静默行为，不能靠猜测恢复。

## 真机验收

在独立测试 profile 使用本 PR 分支，记录 DSH/插件版本及最终提交 SHA。生成两次不含私密信息的模型输出：先是完整报告，再因子代理完成通知产生纯 `[SILENT]`，确认日志中两次输出属于同一 turn、不同已完成 step；微信只收到报告一次。再检查纯静默、带工具的中间文本及正常最终答复。

若仍未收到，先查看是否存在 recovered 日志；若没有，只需脱敏事件类型、seq、turn/step、finish.kind、interrupted、content block types 和 source.kind 来核验契约，不必导出私人正文。发送及 outbox 结果应单独核验。
