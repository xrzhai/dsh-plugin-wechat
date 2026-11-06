<div align="center">

<img src="assets/icon-128.png" width="72" alt="dsh-plugin-wechat" />

# dsh-plugin-wechat

**在微信里随时使唤你的 DeepSeek Harness**

[**English**](README.en.md) · [**MIT License**](LICENSE)

</div>

离开电脑也能在微信里用 **DeepSeek Harness（DSH）**：

- **派活、收发文件**：把材料从微信发给电脑，让它查资料、改代码、写文档。也可以直接说“把桌面上的报告发给我”，取回电脑上能读取的普通文件。
- **跟进后台子任务**：插件运行时，主会话收到子任务的后续汇报，可以推回微信。
- **查看和指挥桌面上的其他 DSH 会话**：“帮我看看电脑上那个会话跑到哪一步了？”“让那个会话先停一下。”默认开启，直接描述项目或任务，无需手抄会话 ID。

## 一、安装

打开电脑上的 DSH，把这句话发给它：

```text
请帮我安装这个微信插件，按 README 的 Agent 安装指南执行：https://github.com/xrzhai/dsh-plugin-wechat
```

安装完成后，**完整退出并重新打开 DSH**。

## 二、绑定微信

1. 打开侧栏「大肥鱼 → 微信账号 → 扫码登录微信」，用手机微信扫码。
2. 如果还没设置允许名单，用你自己的微信先发一句“你好”或 `/status`。插件把第一位实际发来消息的联系人登记为主人，请在「微信账号」里核对。
3. 想改助理的工作方式，打开「人设」。想指定项目文件夹，打开「高级 → 基本设置」，填写「助理默认在哪个文件夹工作」并保存。留空则使用插件自己的工作区。

## 三、在微信里怎么用

想找电脑上的任务，可以说：“列出最近的 DSH 会话，找一下写周报的那个。”确认目标后，可以查进度、给运行中的任务补一句要求或请求停止，也可以让空闲会话接着做。归档会话只能查看；如果宿主不能恢复历史会话，先在桌面打开它。

当前账号允许对话的人默认都能管理本机的普通 DSH 会话。只想在微信里跟助理聊天，可到「高级 → 远程查看与管理 DSH 会话」关闭开关。要限制特定联系人、目标或工作区，见[跨会话调度配置](docs/session-dispatcher.md)。

下面的快捷口令由插件直接处理，不消耗模型额度。`/list` 列出的是这段微信聊天的话题；要查桌面上的其他会话，直接用自然语言问。

| 你在微信里发 | 它的作用 |
| :--- | :--- |
| `/new` 或 `/new 写周报` | **开个新话题**（之前的聊天记录还留着，不会丢） |
| `/list` | **看历史话题列表**，会列出编号 `1, 2, 3...` |
| `/use 2` | **切回第 2 个话题**继续聊 |
| `/clear` | 清空话题列表，DSH 中的原有历史保留 |
| `/cancel` 或 `/取消` | 请求停止当前回复；子任务是否停止需要另行确认 |
| `/compact` 或 `/压缩` | 聊太久上下文满了，发这句让它自动压缩瘦身 |
| `/status` | 看看当前连没连上、正在哪个话题里 |
| `/outbox`、`/outbox retry` | 查看本聊天的待发数量，或手动重试。先看消息是否已经收到：回执超时后重试可能重复。 |
| `/send 文件路径` | 让它把电脑上的某个文件直接发到你微信里 |
| `/help` 或 `/帮助` | 忘了口令时调出小抄菜单 |

要交付文件，让助理在回复中写明路径，或发 `/send 文件路径`。默认可发送电脑上助理能读取的普通文件，不限工作目录。主人默认不受消息频率限制。[安全边界](docs/security.md)说明了文件大小、凭据和权限范围。

## 四、常见问题

- **连接失败或登录过期？** 安装或升级后先完整重启 DSH。登录过期时，在「微信账号」重新扫码。
- **合盖后收不到回复？** 电脑睡眠时连接会暂停，唤醒后等待重连。
- **想升级？** 告诉 DSH：“帮我更新微信插件。”更新后重启 DSH。

## 五、Agent 安装指南

在固定目录安装，DSH 会链接到这份源码。需要 Git、Node ≥ 22.13.0 和 pnpm；macOS 终端找不到 Node 或 pnpm 时，使用 DSH 自带的运行时。将下例的 `desktop` 换成实际使用的 profile。

```sh
git clone https://github.com/xrzhai/dsh-plugin-wechat.git
cd dsh-plugin-wechat
pnpm install
node bin/install.mjs --profile desktop
npm run doctor -- --offline
```

升级时在原目录运行 `git pull`，再执行依赖安装、插件安装和离线检查，最后完整重启 DSH。卸载用 `node bin/install.mjs --profile desktop --uninstall`，凭据和聊天记录会保留。

## 六、致谢与协议

本项目基于 [panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin) 与 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)。[MIT License](LICENSE)。
