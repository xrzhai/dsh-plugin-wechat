<div align="center">

# dsh-plugin-wechat · 微信远程控制面

**把你的个人微信，变成 DeepSeek Harness (DSH) 的生产级远程工程控制面。**

在手机微信里发一句话，唤醒并调度你本机正在运行的 DSH Agent —— 文字、图片、文件、语音（本地 ASR）双向互通，异步 Subagent 结果保序回推，支持跨项目平行会话调度。

![Node.js >= 22.13.0](https://img.shields.io/badge/node-%3E%3D22.13.0-339933?logo=node.js&logoColor=white)
![DSH >= 0.2.2](https://img.shields.io/badge/DSH-0.2.2%2B-4D6BFE)
![Zero Prompt Pollution](https://img.shields.io/badge/Prompt-Zero_Pollution-10B981)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**简体中文** ｜ [English](README.en.md)

<img src="assets/icon-128.png" width="80" alt="dsh-plugin-wechat 图标" />

</div>

<img src="assets/hero.png" alt="在微信里与本机 DSH Agent 对话与调度" />

---

## 1. 定位与开源致谢 (Positioning & Acknowledgment)

本项目基于 **[panqing0313](https://github.com/panqing0313)** 开源的先驱项目 [`dsh-plugin-weixin`](https://github.com/panqing0313/dsh-plugin-weixin) 深度重构与演进。**本仓库为自包含独立安装包（内置插件核心、管理面板、安装器与 vendored 微信 iLink 传输层），新用户只需本仓库与已配置的 DSH 即可直接安装使用，无需预先安装上游插件。**

向原作者 **panqing0313** 致以诚挚感谢：他率先跑通了基于腾讯官方 `iLink Bot API`（`@tencent-weixin/openclaw-weixin`）的免挂纯 Web 扫码通道，并构建了多账号独立长轮询、本地 Whisper 语音转写桥接与设置卡 UI，为 DSH 社区连接个人微信奠定了扎实的工程基石。

### 为什么要做这个演进版？（设计哲学的分野）

两个项目面向截然不同的核心场景：

- **上游原版（[`panqing0313/dsh-plugin-weixin`](https://github.com/panqing0313/dsh-plugin-weixin)）**：定位为**全功能陪伴型微信助手**，内置丰富的长期情感记忆、好感度关系曲线、生活作息状态推断、模拟真人拆气泡延迟以及 11 套角色人设与内置表情包。
- **本仓库（[`xrzhai/dsh-plugin-wechat`](https://github.com/xrzhai/dsh-plugin-wechat)）**：定位为**面向重度工程、量化回测与投研工作流的生产级远程控制面（Engineering Control Surface）**。

在 DSH 0.2.2+ 的生产环境中，Agent 的日常是**长达数十分钟的命令行执行、密集并发的异步 Subagent 派发、以及桌面端多个工程会话的并行推进**。为此，我们在保留原版优秀传输层与多模态能力的基础上，做了坚决的**“减法”**与硬核的**“加法”**：

| 维度 | 上游陪伴版 (`dsh-plugin-weixin`) | 工程控制面版 (`dsh-plugin-wechat`) | 解决的核心工程问题 |
| :--- | :--- | :--- | :--- |
| **每轮提示词纯净度** | 每轮自动前置注入 `<weixin_memory>` / `<weixin_life>` 等多块上下文 | **零 Prompt 污染（Zero Prompt Pollution）** | 剥离每轮隐式 XML 标签注入，100% 交由宿主 `AGENTS.md` 与原生前缀缓存 Compaction 接管，省 Token 且不干扰长链推理 |
| **Subagent 异步多回合回推** | 单游标读取，后一 Turn 直接覆盖前一 Turn | **`readSettledTurns` 按回合边界切片保序交付** | 解决主 Agent 汇总 Subagent 结论（Turn $N$）后，紧随其后的子代理退出通知（Turn $N+1$ `[SILENT]`）把真实结论吞没的顽疾 |
| **同回合末尾静默抢救** | 仅取 Turn 末尾文本，末尾 `[SILENT]` 导致整轮静默 | **`replyBeforeSilent` 有限状态机无损抢救** | 当 Step 1 已输出完整答复（`finish(stop)`），而子代理退出通过 `steer` 触发同 Turn 的 Step 2 输出 `[SILENT]` 时，安全救回 Step 1 正文 |
| **跨项目平行会话调度** | 微信仅能与自身绑定的单一会话线性对话 | **`SessionDispatcher` 显式授权跨会话调度** | 出门在外可通过微信调用 `session_list / query / dispatch`，对桌面端其他项目会话执行 `followup`、`steer` 纠偏或 `cancel` 中止 |
| **长代码块投递保真度** | 超过 1200 字的代码块转文件附件，上传失败即丢正文 | **调度结果强制 `richContent: false` 纯文本分段** | 确保跨会话调度的长代码与日志 100% 通过文本气泡完整送达手机，绝不因 CDN 媒体上传波动丢失正文 |
| **入站持久化与防误重跑** | 内存态消费，重启易丢未处理消息 | **`inbound-pending` 先落盘后移游标 + 状态区分** | 未开始的消息在重启后自动恢复；已启动但中断的任务留痕告警、不自动重跑，防止包含写操作的工程命令被重复执行 |
| **出站断点续传与 Token 自愈** | 整条重发、超 10 分钟持死 Token 重试、进度提示堆成死信 | **分片断点续传 + 8 分钟主动刷新 + `durable:false` 分流** | 出站按分片记录进度（At-least-once 续传）；超 8 分钟自动刷新凭证走无 token 通道；进度提示失败即弃不进队列，死信自动剪枝 |
| **控制面板与网关热启停** | 13 个综合页签；状态查询失败易误判为未登录 | **极简 4 页签工程面板 + `Live Gateway Switch` 热启停** | 聚焦「账号、会话、工作区指令、网关配置」4 个核心页签；区分服务异常（支持一键重试）与未登录；开关保存即刻热启停并平滑排水 |

---

## 2. 核心工程机制深剖 (Architecture Deep Dive)

### 2.1 零 Prompt 污染：把上下文控制权交还给 Harness
在长上下文推理（1M Context + 400k 自动 Prefix-Cache Compaction）场景下，网关层如果在每一轮 User Message 前动态拼接变化的记忆块、时间状态或好感度标签，不仅每轮额外消耗 Token，还会破坏模型对指令层级的注意力分布。
- `dsh-plugin-wechat` 默认移除了普通对话回合中的隐式 Prompt 注入与拟人化拆气泡延迟；
- 会话规范完全遵循工作区根目录下的 `AGENTS.md`（设置卡内置「工作区指令」页签，可直接在线编辑目标项目的 `AGENTS.md`）。

### 2.2 异步 Subagent 连续回合切片与同回合静默抢救
在 DSH 0.2.2+ 的多智能体拓扑中，子代理（Subagent）的生命周期与主会话事件流存在两种典型的竞态窗口：
1. **跨回合吞没（Multi-Turn Overwrite）**：主 Agent 在 **Turn $N$** 汇总完所有 Subagent 的调研结果并生成长文报告；几百毫秒后，Subagent 进程彻底退出向宿主投递系统通知，触发 **Turn $N+1$**，主模型按规范回复 `[SILENT]`。[`src/session-reader.js`](src/session-reader.js) 中的 `readSettledTurns({ events, afterSeq })` 严格以 `turn/start` 至 `turn/end` 为边界切分所有已结算回合，在 `#pollSpontaneous()` 中逐轮保序下发实质内容，遇到 `[SILENT]` 仅推进游标而不覆盖前序成果。
2. **同回合末尾静默（Same-Turn Trailing Silent）**：一个 Turn 可包含多个 Step。当模型在 **Step 1** 已正常结束正式回复（无工具调用、`finish(stop)`），恰逢子代理退出通知通过 `steer` 进入同回合的 **Step 2** 且模型输出 `[SILENT]` 时，`replyBeforeSilent` 状态机会严格核验 Step 1 的起止边界、确认无未捕获异常与工具调用、且中间无真人新指令插入后，精准提取 Step 1 的正式答复出站（详见 [`docs/silent-reply-recovery.md`](docs/silent-reply-recovery.md)）。

### 2.3 显式授权的平行会话调度 (`SessionDispatcher`)
让你在手机微信上成为整台工作站的调度中枢（详见 [`docs/session-dispatcher.md`](docs/session-dispatcher.md)）：
- **三大原语工具**：向授权微信主会话注入 `session_list`（列出桌面端活跃/空闲会话）、`session_query`（只读查看目标会话最近事件与执行状态）、`session_dispatch`（向目标会话下发指令）。
- **三种控制动作**：`followup`（目标空闲时追加任务）、`steer`（目标运行中实时注入纠偏指令）、`cancel`（紧急中止当前执行回合）。
- **纵深防御沙箱**：默认关闭，需在「网关配置 → 平行会话调度」中显式开启，并同时配置 `sessionDispatcherSenders`（发送者白名单）与 `sessionDispatcherTargets`（目标会话 ID 精确白名单，无通配符）；`readOnlyPaths` 与 `protectedSessions` 结合 `realpathSync` / Windows Junction 解析防止软链越界；代码级禁止 Subagent 继承调度工具，调度结果强制以 `richContent: false` 纯文本分段投递。

### 2.4 入站防丢、出站分片断点续传与 8 分钟 Token 自愈
- **入站持久化与安全恢复（`inbound-pending`）**：收到微信消息后先持久化待处理记录，再推进服务端 `getUpdates` 游标。若进程重启：尚未开始执行的记录自动恢复；已进入执行但中途中断的记录保留现场并告警，不自动重跑，避免重复执行带副作用的工程操作。
- **出站分片断点续传（At-least-once）**：长回复切分为多条分片发送时，持久队列记录已送达的分片索引；遇到网络抖动重试时，从断点分片继续投递，避免整篇重复发送。
- **8 分钟安全窗口与死信剪枝**：微信 iLink 的 `context_token` 有效期约 10 分钟。当回合耗时超过 8 分钟，网关发送前自动通过 `sendToken()` 刷新 typing ticket 并切换至无 token 兜底路径；进度提示标记为 `durable: false`（失败即弃不落盘），`outbox.flush` 自动剥离过期 token 重试并定时清理真正耗尽重试的死信。

---

## 3. 从零安装、升级与卸载 (Quick Start)

### 3.1 环境准备
1. 已安装并启动过 DSH（默认使用 `desktop` profile），完成模型配置并确认桌面端对话正常。
2. 本机已安装 Git、Node.js **>= 22.13.0** 与 `pnpm`。
3. 安装或升级插件前，先等待 DSH 中正在运行的任务结束并退出 DSH。

### 3.2 获取源码并一键挂载

在计划长期存放插件的目录（如 `D:\Projects`）执行：

```bash
git clone https://github.com/xrzhai/dsh-plugin-wechat.git
cd dsh-plugin-wechat
pnpm install
node bin/install.mjs --profile desktop
```

安装脚本会自动校验运行时依赖、在目标 Profile 的 `package.json` 中登记 `dsh-plugin-wechat` 的 `link:` 软链与 `bundles` 入口，并清理旧版残留挂载（若 Profile 使用冻结锁文件，可加 `--pin` 同步刷新锁文件）。

> **旧版无感迁移**：本插件底层 Cordis 实例 ID 保持为 `dsh-weixin`，状态与凭证目录保持为 `~/.dsh/weixin/`（权限 `0600`）。从旧版 `dsh-plugin-weixin` 切换过来时，**已绑定的微信号、白名单、历史会话与配置项 100% 自动保留，无需重新扫码**。

### 3.3 扫码绑定与连通性验证

1. 重新打开 DSH，进入 **「设置 → 插件 → 微信BOT」**（或点击左侧栏 **「微信BOT」** 图标）。
2. 在 **「网关配置」** 页签中设置默认工作目录（`cwd`），指向你希望 Agent 默认工作的项目目录。
3. 在 **「微信账号」** 页签点击 **「扫码登录微信」**，用手机微信扫码完成绑定（终端也可运行 `npm run login`）。
4. **由你本人发送第一条微信消息**：初始白名单默认为空（拒绝所有人），新绑定账号收到的**第一条消息**会自动将该发信人登记为账号主人并放行。随后发送 `/status` 与任意问题，验证收到回复即可。
   - 若界面提示连接异常，可点击「重试」或重启 DSH；仅在提示「登录已过期」时才需重新扫码。

```bash
npm run onboard            # 查看上手配置就绪清单
npm run doctor -- --offline # 运行 13 项本地离线环境体检
```

### 3.4 升级与卸载

```bash
# 升级（先退出 DSH）
git pull && pnpm install && node bin/install.mjs --profile desktop

# 卸载（仅解除 Profile 挂载，保留本仓库源码、微信凭证与历史数据）
node bin/install.mjs --profile desktop --uninstall
```

---

## 4. 微信端交互与命令速查 (Commands & Controls)

所有斜杠指令均由网关在本地直接拦截响应，**不消耗任何模型 Token**（仅 `/compact` 透传给宿主执行上下文压缩）；未知斜杠指令也会被安全拦截并提示，防止手误发给模型。

### 4.1 会话与执行控制

| 微信发送指令 | 功能说明 |
| :--- | :--- |
| `/new [标题]` | 开启一条全新的 DSH 会话线（旧会话完整保留在宿主中，随时可切回） |
| `/list` 或 `/sessions` | 列出当前微信账号下的所有历史会话线及序号 |
| `/use <序号>` | 切换到指定序号的历史会话线继续工作 |
| `/cancel` 或 `/取消` | **紧急中断**：在长任务运行期间随时发送，立即中止当前正在执行的 Agent 回合 |
| `/compact` 或 `/压缩` | 透传触发 DSH 宿主原生的上下文无损压缩（Compaction） |
| `/status` | 查看当前账号连接状态、活跃会话线、白名单来源与待发提醒 |
| `/diag` / `/diag export` | 网关实时自检报告 / 导出一份脱敏的排障体检包 |
| `/outbox` / `/outbox retry` | 查看出站待重发队列 / 立即触发断点续传 |
| `/send <本地文件路径>` | 将 `mediaDirs` 白名单目录内的指定文件直接发回手机微信 |
| `/help` 或 `/帮助` | 查看当前支持的所有快捷指令清单 |

### 4.2 跨会话调度桌面项目（开启 `sessionDispatcherEnabled` 后）

在「网关配置 → 平行会话调度」中开启开关，并填入你的微信 ID（`sessionDispatcherSenders`）与允许调度的目标会话 ID（`sessionDispatcherTargets`）后，直接在微信里用自然语言对主 Agent 说：
- *“帮我看看现在桌面上有哪几个项目会话在跑？”*（调用 `session_list`）
- *“看一下量化回测那个会话现在跑到哪一步了？”*（调用 `session_query`）
- *“给回测会话发个 steer：先别跑全市场，只跑纳指 100 成分股。”*（调用 `session_dispatch` · `action: "steer"`）
- *“把刚才卡住的那个任务会话 cancel 掉。”*（调用 `session_dispatch` · `action: "cancel"`）

---

## 5. 仓库结构与自动化回归 (Repository Layout & Testing)

```text
src/
├── index.js                     # 插件主入口：Cordis 生命周期、入站管线与热启停编排
├── agent-bridge.js              # 微信会话 ↔ DSH Agent 会话桥接、#pollSpontaneous 多回合保序交付
├── session-reader.js            # 事件流解析：readSettledTurns 回合切片 & replyBeforeSilent 状态机抢救
├── session-dispatcher.js        # 平行会话调度核心：权限守卫、软链沙箱与 followup/steer/cancel 派发
├── session-dispatch-reader.js   # 被调度会话的只读快照与完成态追踪
├── session-host.js              # 宿主 Session / Agent 服务契约适配层
├── gateway-control.js           # Live Gateway Switch 实时热启停与在途回合平滑排水
├── outbound.js                  # 出站分片断点续传、代码块处理与产出文件自动投递
├── client.js / client.card.js   # 极简四页签 React 管理面板（微信账号/会话/工作区指令/网关配置）
├── transport/ilink.js           # 微信 iLink 长轮询、入站先落盘游标推进、8 分钟 Token 刷新与媒体收发
├── media/                       # 入站媒体解密、ASR 语音转写桥、OCR 与出站路径安全校验
├── message/                     # inbound-pending 入站恢复、outbox 断点续传、分段、去重与斜杠指令
└── security/allowlist.js        # 默认拒绝的账号级/全局双层白名单
bin/                             # install.mjs 安装器、doctor.mjs 体检、onboard.mjs 上手清单、login.js
vendor/openclaw-weixin/          # 腾讯官方 @tencent-weixin/openclaw-weixin (MIT) 纯净传输层副本
test/                            # 196 项全隔离单元与集成回归测试（零外网请求、沙箱隔离本机凭证）
```

运行自动化回归与静态检查：

```bash
npm test                     # 运行全部 196 项沙箱隔离单元与集成回归测试
npm run test:host-contract   # 验证与当前已安装 DSH Peer 依赖的宿主接口契约
npm run check                # 代码静态检查与依赖核验
```

### 延伸设计文档
- [平行会话调度架构与安全边界 (`docs/session-dispatcher.md`)](docs/session-dispatcher.md)
- [同回合末尾静默回复抢救契约 (`docs/silent-reply-recovery.md`)](docs/silent-reply-recovery.md)
- [队列并发、附件沙箱与热启停验收 (`docs/validation-issues-23-25.md`)](docs/validation-issues-23-25.md)
- [整体消息链路架构 (`docs/architecture.md`)](docs/architecture.md) · [安全威胁模型 (`docs/security.md`)](docs/security.md)
- [第三方开源声明 (`THIRD-PARTY-NOTICES.md`)](THIRD-PARTY-NOTICES.md) · [版本演进记录 (`CHANGELOG.md`)](CHANGELOG.md)

## License

[MIT License](LICENSE) © 2026 panqing0313, xrzhai (mine), and contributors. Transport layer vendored from [`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) (MIT © 2026 Tencent).
