# 在微信里查看和管理其他 DSH 会话

在微信里说“帮我找一下写周报的会话，看看进行到哪了”，助理可以先列出本机的普通 DSH 会话，再查询匹配项。要改任务，直接说明是给运行中的任务补充要求、请求停止，还是让空闲会话接着做。无需自己查会话 ID。

## 默认权限与配置

跨会话调度默认开启。「高级」里，前三组常用设置之后的「远程查看与管理 DSH 会话」只提供总开关。需要更细的限制时，编辑插件配置：

```json
{
  "sessionDispatcherEnabled": true,
  "sessionDispatcherSenders": [],
  "sessionDispatcherTargets": [],
  "protectedSessions": [],
  "readOnlyPaths": []
}
```

- 先检查当前微信账号的有效允许名单（账号自己的名单，或它继承的全局名单）。自动认主登记的联系人也可使用，不需要再填全局名单。
- `sessionDispatcherSenders` 留空表示该账号所有已获准对话的联系人都可以使用；填入微信用户 ID 后，仅其中已获准的联系人可以使用。此配置不能给原本未获准的人授权。
- `sessionDispatcherTargets` 留空表示所有本机普通 DSH 会话；非空时按完整会话 ID 限制列出、查询和调度的范围，不支持通配符。各调度者共用这份目标名单。
- 当前来源会话、其他微信控制会话及内部子会话都不是访问目标。归档会话、`protectedSessions` 列出的会话及 `readOnlyPaths` 下的会话可查看，不能通过调度工具接收新任务、补充指令或停止请求。只读路径填绝对路径，包括子目录和链接别名。
- 关闭开关或撤销联系人、目标的权限，会阻止后续调用和结果回推。

## 工具和宿主限制

`session_list` 支持状态、标题/ID、工作目录关键词、1–50 条限制。输出有整体字符预算。冷会话若宿主不能低成本提供事件数量，`totalEvents` 为 `null` 而不是假报 0；其 `lastUpdatedMs` 可能仅为创建/标题更新时间，结果会说明。`session_query` 才读取完整快照得到精确事件数，返回最近 1–20 轮内的有界文本和工具状态，不返回推理内容。

`session_dispatch` 需要：目标 ID、`followup|steer|cancel`、非空指令，以及可选 `sync|async` / `timeout_ms`（默认 60 秒，最大 300 秒）。所有控制行为均要求目标写权限。

- 空闲且没有待处理 inbox 的项目可 `followup`。忙碌或遗留待处理输入时拒绝，不暗中排队、清空旧消息、顺带执行旧任务或抢占桌面工作。
- 运行中项目可 `steer` 或 `cancel`。cancel 保留尚未执行的 inbox，且必须观察对应回合以用户原因 aborted 才报告取消成功。
- 同步等待超时返回 `mode: async` 和同一 `dispatchId`。这不是任务失败，也不是重投许可；先查询目标。
- 异步结果带追踪 ID，只送回原始账号和聊天。已暂停/不存在的账号不回落到别的账号；项目文本不经附件解析或自动文件发送。

## 实际宿主契约与降级

适配器基于官方 DeepSeek Harness 源码提交 [`8bd073392eef6f54e921a093b95076248eb08cbb`](https://github.com/deepseek-ai/deepseek-harness/commit/8bd073392eef6f54e921a093b95076248eb08cbb) 核对：

- `agents.list/get/resume`，`agent.status`、`followup/steer/cancel`、`agent.session.snapshotEvents()`。
- `sessionQuery.listSessions/readSession/readTitle`；无查询服务时只能列举/读取宿主可读的活跃会话。
- `workspaceRegistry.archivedSessionIds` 和 `sessionTitle.get(session)`。标题缺失可用 ID；无可靠读取/恢复能力时报明确错误。
- `agentPresets.mount` 恢复记录中的最新 preset，不用微信 preset、cwd 或模型覆盖项目。恢复失败不会创建同名替代会话、清空 inbox 或取消归档。
- **冷恢复要求现代持久模型选择契约**：宿主包须导出 `AgentModel` 和 `modelSelectionProjectionDefinition`，恢复出的 Agent 须提供 `model.current()`。npm `@deepseek-ai/dsh-agent@0.1.0-rc.6` 的同名 `installModelSelection(ctx, selection)` 是旧的路由控制接口，不等同于现代单参数 notice hook。旧版、未知契约或宿主包不可加载时，冷恢复明确拒绝；不会以空状态或全局默认模型冒充恢复。可先在 DSH 中打开目标会话，再借用 live Agent。只读查询不受此限制。
- 现代宿主的模型恢复由核心 loop 完成；`installModelSelection` 仅追加模型切换提示。精简上下文若无 `.on()`，可以省略该提示；有安装器但内部报错仍会中止未发布的恢复。已安装包的传递依赖缺失不会被当成“可选包不存在”吞掉。

这一区别来自官方 [持久模型选择迁移说明](https://github.com/deepseek-ai/deepseek-harness/blob/e39b5f58c229327a2f89221b0b542594786396c5/docs/upgrade-guide/v0.2.1-alpha.3/session-model-selection/guide.zh.md)；包名或版本下限本身不能证明具备该能力。
- `agent.ctx.tools.register` 及执行期 `exec.agent`。未安装/不兼容的工具服务不会让微信插件启动失败。
- `agent/inbox/claimed` 的 `message.id` 与数值 `turn`，以及持久 `user/message.source.dispatchId` / `turn/start` / `turn/end`。队列插入不表示任务已归属某个回合；不会以“最后一条 Assistant 消息”猜结果。

老宿主若缺少 claimed 事件，仍可通过实际消费的 `user/message` 关联正常任务；若 pre-step 在消费前失败且没有可用 claimed 事件，只能报告无法确认而不会错误领取其他回合结果。

## 安全性与明确边界

- 同一运行回合若被不同微信发送者 steer，将拒绝该回合后续的调度调用，避免沿用原发送者的权限。
- 防递归由代码检查真实的执行 Agent 对象及宿主当前 live 身份，不能通过模型传参更换来源。工具在主会话局部注册且有激活条件；继承它们的 subagent 在执行期仍被拒绝。其他微信控制会话、subagent-owned 目标、自身、归档目标均拒绝写入。
- `dispatchSource` 和 `dispatchId` 放入 relay 类型的消息 source，不冒充直接用户输入，也不重复注入隐藏 system prompt。
- **只读策略是调度工具的目标准入，不是文件系统沙箱。** 它不阻止目标已有 shell/其他工具访问别的目录，不限制其他插件，也不自动脱敏历史。只向可信操作者开放相应会话。
- 同一插件实例中的重复 followup 有锁；最终 live 状态/身份检查到同步投递之间没有 await。宿主 API 没有 `expectedTurn` 或跨进程 compare-and-enqueue 参数，不能承诺在不遵守宿主单写入者规则的其他进程/插件下原子操作某个 run。steer 结果跟随实际 claimed turn，cancel 跟踪请求时的当前 turn。
- 异步追踪仅存在内存，最长观察一小时。达到观察窗口、事件读取失败或插件退出不代表目标执行失败；回执会明确结果不确定。**没有持久派发账本、重启重放/恢复或端到端 exactly-once 交付承诺。** 不应在不确定时自动重投。
- 微信发送使用现有 `sendChunked` / durable outbox。接受发送或入队不证明用户手机已收到；网络重试沿用现有至少一次语义。没有可用原账号时不会跨账号发送。
- 插件关闭会移除工具并停止观察。借用的桌面 live agent 不由本模块 dispose；由本模块冷恢复并持有的会话遵循宿主 ownership，插件卸载时可能被停止。它的持久历史仍留在宿主中。

## 验证与本机交接

云端测试完全使用临时 HOME/state、合成会话与假传输，禁止真实网络。真实 Cordis、`apply()`、AgentBridge、配置控制器与两账号网关路由有集成覆盖；普通单测的 DSH Agent/Tool/SessionQuery 服务和现代模块能力为显式注入的 mock，不随机器是否安装可选 peer 改变。未调用真实模型、未连接微信、未部署。

- `npm test` 运行隔离单元与集成测试。路径检查拆成普通路径和目录别名两项；Windows 别名使用无需符号链接特权的目录 junction，其他平台使用目录 symlink。别名安全断言不 skip，文件系统异常不被吞掉。这不等于已在 Windows 真机验证，也不单独验证 Windows 的特权 symlink 创建。
- 在已安装 DSH peer 的环境运行 `npm run test:host-contract`。它真实导入宿主包，缺包直接失败。旧接口测试验证“在激活前拒绝 + 仍可读取/借用 live”；现代接口测试用真实 `AgentModel` / projection 验证持久选择、显式/默认推理强度和 notice hook。真实 rc.6 的拒绝测试通过，不能宣传为现代冷恢复已经实测。
- 真实 Windows / DSH 完整 loop / 微信送达仍是独立验收项；安装依赖时的 peer 不兼容告警必须单独核对，单元测试通过不等于依赖图兼容。

本机操作者在独立测试 profile 中验证，勿直接对生产项目试 cancel：

1. 记录 DSH / Node 版本和 插件提交号；运行 `npm test`、`npm run check`、`npm run test:host-contract`，保留各项结果。若最后一项显示 legacy refusal，应更新到受支持的现代宿主，或仅验收已有 live 会话；不要将拒绝测试视为冷恢复成功。
2. 使用两个合成项目会话、一个微信测试主会话；用自动认主的联系人验证默认可列出、查询和调度两个项目，未获准的联系人不能访问。再分别收窄发送者和目标名单，确认不在范围内的联系人或目标无法访问；关闭总开关后两者均不可访问。
3. 验证活跃/冷会话列表与标题，冷 query 不唤醒，冷 resume 保持项目 cwd / 最新 preset / 模型设置；归档会话只读。
4. 空闲 followup 返回其自身结果；忙碌 followup 拒绝；steer 纠偏；cancel 仅操作合成任务并保留待处理 inbox。
5. 让两个完成回合在同一轮询间隔内发生，其中第二个 `[SILENT]`；派发结果应仍为对应回合，而不是最后一个回合。
6. 超短同步窗口返回追踪凭证，完成后仅原账号收到文本结果，无自动附件上传；切换账号、暂停账号、撤销发送者/目标时不发到别处。
7. 自调用、继承工具的子代理、其他微信控制会话、只读路径的符号链接均被拒绝；配置无关目录/兄弟前缀不应误判为子目录。
8. 主动卸载测试插件，记录冷恢复任务的宿主清理行为与未发送通知；重启后先 query，不盲目重投。
