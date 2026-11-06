<div align="center">

<img src="assets/icon-128.png" width="72" alt="dsh-plugin-wechat" />

# dsh-plugin-wechat

**在微信里随时使唤你的 DeepSeek Harness**

[**English**](README.en.md) · [**MIT License**](LICENSE)

</div>

离开电脑桌的时候，直接用手机微信给家里或办公室电脑上的 **DeepSeek Harness (DSH)** 发消息干活：

- **随时派活**：在微信里说句话，电脑上的 Agent 帮你查资料、改代码、写文档、跑任务，跑完直接把结果或生成的文件发回你微信；
- **子任务不漏回**：就算主 Agent 派了好几个子 Agent 跑上十几分钟，跑完也会自动把汇总结果推到你微信上；
- **纯本地更安心**：所有账号凭证和聊天记录都只存在你自己的电脑里（`~/.dsh/weixin/`），不经过任何第三方服务器。

---

## 一、 怎么装？（最省事的方法：让你的 DSH 自己装）

你**不需要**自己敲命令行。直接打开你的 DeepSeek Harness，把下面这句话复制发给它：

```text
请帮我安装这个微信插件，直接读它的 README 按里面的 Agent 安装步骤执行：https://github.com/xrzhai/dsh-plugin-wechat
```

等它提示你安装完成后，**完整退出并重新打开一次 DSH** 就可以了。

---

## 二、 装好之后怎么绑定微信？（只需 1 分钟）

### 第 1 步：扫码登录
打开 DSH，点击左侧边栏的 **「大肥鱼」**（或者去「设置 → 插件 → 大肥鱼」），点击 **「扫码登录微信」**，用手机微信扫一下屏幕上的二维码。

### 第 2 步：设个默认文件夹（可选）
切到上方的 **「网关配置」** 页签，在 **「默认工作目录 (cwd)」** 里填上你平时让 AI 干活的文件夹路径（比如你的笔记目录或项目目录），点保存。

### 第 3 步：用你的手机微信发第一句话（自动认主）
为了防止别人乱指挥你的电脑，插件默认对所有人都不理睬。
绑定成功后，**拿你自己的手机微信给它发第一句话**（比如发个 `你好` 或 `/status`），它就会自动把你登记成唯一主人。从这之后，你随时发文字、图片、文件，它都会帮你处理了！

---

## 三、 日常好用的几个微信小口令

平时正常打字聊天就行。下面这几个 `/` 开头的口令是插件自带的快捷键，**不消耗大模型额度**：

| 你在微信里发 | 它的作用 |
| :--- | :--- |
| `/new` 或 `/new 写周报` | **开个新话题**（之前的聊天记录还留着，不会丢） |
| `/list` | **看历史话题列表**，会列出编号 `1, 2, 3...` |
| `/use 2` | **切回第 2 个话题**继续聊 |
| `/cancel` 或 `/取消` | **紧急叫停**：看它跑偏了或者跑太久，发这句立刻停下 |
| `/compact` 或 `/压缩` | 聊太久上下文满了，发这句让它自动压缩瘦身 |
| `/status` | 看看当前连没连上、正在哪个话题里 |
| `/send 文件路径` | 让它把电脑上的某个文件直接发到你微信里 |
| `/help` 或 `/帮助` | 忘了口令时调出小抄菜单 |

### 💡 进阶小功能：在微信里指挥电脑上正在跑的其他任务
如果你电脑桌面上已经开了另一个 DSH 窗口在跑大任务，出门后想用微信看它跑得怎么样、或者中途改要求：
1. 在「网关配置 → 平行会话调度」里勾上 **「启用平行会话调度」**；
2. 把你的微信 ID 填进「调度者发送者 ID」，把桌面那个会话的 ID 填进「允许访问的目标会话 ID」并保存；
3. 之后直接在微信里跟它说：*“帮我看看电脑上那个会话跑到哪一步了？”* 或 *“让那个会话先停一下”* 即可。

---

## 四、 常见问题

- **界面提示「微信服务连接失败」？**
  刚装完或刚升级完插件时，必须**完整退出并重新打开一次 DSH** 后台服务才会挂载生效；平时遇到点一下「重试」即可。
- **提示「登录已过期」？**
  打开「大肥鱼 → 微信账号」重新点一次扫码即可（你之前配好的工作目录、白名单和历史会话全都在，不会丢）。
- **以后怎么升级新版本？**
  直接对你的 DSH 说：*“帮我更新一下 `dsh-plugin-wechat` 插件”*，重启 DSH 即可。

### 🍎 macOS 上要注意的几件事

- **终端里不一定有 `node` / `pnpm`。** DSH 自带运行时，但不会写进你的 PATH，所以 `node bin/install.mjs`、`pnpm install` 在普通终端会 command not found。把自带运行时接进来（可写进 `~/.zshrc`）：
  ```sh
  export PATH="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH"
  pnpm() { node "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs" "$@"; }
  ```
  扫码登录不需要命令，直接用「大肥鱼 → 微信账号 → 扫码登录微信」。
- **`ffmpeg` 系统不自带。** 想发 mp3/m4a/ogg 语音条、想给视频抽帧，先 `brew install ffmpeg`。没装时这两条路会降级：音频退成文件发送，视频抽帧静默跳过；wav 和 silk 走内置编码器，不受影响。
- **语音识别（ASR）别用系统 Python。** `/usr/bin/python3` 是 3.9，且没有 `mlx-whisper`。用 DSH 自带的 3.12：
  ```sh
  ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python -m pip install mlx-whisper
  ```
  然后把 `asr.command` 设成这个 python 的绝对路径；Apple 芯片会走 GPU，比 CPU 快得多。
- **笔记本合盖会睡。** 睡眠期间长轮询和定时提醒都停；唤醒或重启后，错过的提醒会立即补发，不会静默丢掉。

---

## 五、 给 AI Agent 看的自动安装与维护指令 (For AI Agents Only)

> **Agent 指令说明**：当用户让你安装、更新或卸载本插件时，请直接按以下步骤在终端执行，无需用户手动操作。

### 1. 环境与目录选择
- 开发验证和文案基线规则见 [开发检查](docs/development-checks.md)；安装前可用 `node bin/install.mjs --help` 查看参数，或追加 `--dry-run` 预览变更。
- 确认本机具备 `git`、`node`（需 `>= 22.13.0`）与 `pnpm`。**macOS 上 `node`/`pnpm` 常常不在 PATH 里**：优先使用 DSH 自带的 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node` 和同目录下的 `pnpm/bin/pnpm.cjs`，不要再要求用户额外安装一套 Node。
- **重要**：安装脚本会将用户的 DSH Profile 通过软链接（`link:`）指向本仓库目录。因此**请勿将仓库克隆在 `/tmp` 或临时目录**，请克隆在用户固定的项目目录（例如 `~/Projects/dsh-plugin-wechat` 或 `D:\Projects\dsh-plugin-wechat`）或 `~/.dsh/plugins/dsh-plugin-wechat`。

### 2. 从零安装步骤
```bash
git clone https://github.com/xrzhai/dsh-plugin-wechat.git
cd dsh-plugin-wechat
pnpm install
node bin/install.mjs --profile desktop
```
- 如果用户的 DSH Profile 使用了其他名称（可通过查看 `~/.dsh/profiles/` 确认），请将 `--profile desktop` 替换为实际 Profile 名称。
- 若遇到冻结锁文件提示，可追加 `--pin`（`node bin/install.mjs --profile desktop --pin`）。

### 3. 安装后自检与汇报
```bash
npm run doctor -- --offline
```
- 安装脚本跑通后，请明确告知用户：
  1. **请先完整退出并重新打开一次 DSH 客户端**；
  2. 重启后点击左侧栏 **「大肥鱼」** 扫码登录，并用手机微信发第一条消息完成自动认主。

### 4. 工作区路径与显示名（配置项，不要让 Agent 写死在代码里）

微信会话默认落在一个**独立工作区**：目录来自插件状态目录（默认 `~/.dsh/weixin/sessions`，根目录可用环境变量 `DSH_WEIXIN_STATE_DIR` 覆盖）。**不要把具体路径写死在代码或提示词里**，按用户实际环境用 `config.json` 配置：

| 配置项 | 作用 | 默认 |
| :--- | :--- | :--- |
| `cwd` | 微信会话的工作目录（绝对路径）。留空 = 用插件自带的 `sessions` 工作区；填了就把微信会话并进用户指定项目的工作区 | 空 |
| `workspaceTitle` | 上面这个**自带工作区**的显示名（DSH 默认用目录名当标题，所以会显示成 `sessions`）。只在标题仍是目录名时生效，用户在界面改过的名字不会被覆盖 | 空（显示目录名） |

示例——让微信会话仍留在自带工作区，但显示为「大肥鱼」：

```json
{ "workspaceTitle": "大肥鱼" }
```

> 注意：`workspaceTitle` 只作用于插件自带的默认工作区。一旦 `cwd` 指向用户自己的项目，那个项目的工作区名由用户决定，插件**不会**去改它——避免误改别人的项目。

> 新用户开箱体验：首次运行会在插件自带的工作区里种一份 starter 人设 `AGENTS.md` 和一份 `memory.md`（都只在文件不存在时写入，**绝不覆盖已有的人设/记忆**）。人设让「大肥鱼」一上来会自我介绍并引导用户完成称呼、长期记忆、日常提醒等基本设置；记忆就是一个 `memory.md`，大肥鱼**按需读取、自己维护**，不做每轮注入、不跑后台摘要。

### 5. 升级与卸载步骤
```bash
# 升级插件（在已克隆的仓库目录下执行）
git pull
pnpm install
node bin/install.mjs --profile desktop

# 卸载插件（仅解除 Profile 软链挂载，不会删除源码、微信凭证与聊天数据）
node bin/install.mjs --profile desktop --uninstall
```

---

## 六、 致谢与开源协议

本项目基于 **[panqing0313](https://github.com/panqing0313)** 开源的 [`dsh-plugin-weixin`](https://github.com/panqing0313/dsh-plugin-weixin) 重构演进，底层微信通道基于腾讯开源的 [`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)（MIT）。

非常感谢原作者 **panqing0313** 打通微信 iLink 扫码通道与多账号管理基础架构！本分支在此基础上剥离了每轮对话的额外提示词注入，把常用设置精简为「微信账号 + 人设」两个页签，会话与网关配置收在「高级」里，并重点强化了异步 Subagent 多回合防吞、长任务凭证续期、出入站断点恢复以及跨会话平行调度能力。

遵循 [MIT License](LICENSE) 开源。
