<div align="center">

<img src="assets/icon-128.png" width="72" alt="dsh-plugin-wechat" />

# dsh-plugin-wechat

**Control Your DeepSeek Harness Anytime from WeChat**

[**简体中文**](README.md) · [**MIT License**](LICENSE)

</div>

Chat with the **DeepSeek Harness (DSH)** running on your computer directly from WeChat on your phone when you are away from your desk:

- **Command from anywhere**: Send a message in WeChat to have your local Agent research, write code, edit docs, or run tasks, and receive results or files back in WeChat;
- **Never miss async subagents**: Even when a task spawns multiple Subagents running for minutes, final replies are automatically delivered in order;
- **100% local state**: Credentials and chat data stay strictly on your own machine (`~/.dsh/weixin/`).

---

## 1. How to Install (Easiest Way: Let Your DSH Install It)

You don't need to run terminal commands yourself. Just open DeepSeek Harness and send it this line:

```text
Please install this WeChat plugin for me by reading its README and following the Agent installation steps: https://github.com/xrzhai/dsh-plugin-wechat
```

Once your Agent finishes installing, **fully quit and reopen DSH**.

### Platform notes (macOS)

- **`node` / `pnpm` are often not on your terminal PATH.** DSH ships its own runtime but does not export it, so `node bin/install.mjs` and `pnpm install` fail with "command not found". Wire the bundled runtime in (you can put this in `~/.zshrc`):
  ```sh
  export PATH="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH"
  pnpm() { node "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs" "$@"; }
  ```
  You do not need a command to log in: use **WeChat → WeChat Account → Scan QR to Log In**.
- **`ffmpeg` is not bundled with macOS.** Install it with `brew install ffmpeg` if you want mp3/m4a/ogg sent as voice messages or video frames extracted for the model. Without it, audio falls back to a file attachment and frame extraction is skipped silently; wav and silk use the built-in encoder and are unaffected.
- **Do not use the system Python for ASR.** `/usr/bin/python3` is 3.9 and has no `mlx-whisper`. Use the Python 3.12 bundled with DSH:
  ```sh
  ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python -m pip install mlx-whisper
  ```
  Then point `asr.command` at that absolute path. On Apple silicon it runs on the GPU and is markedly faster than CPU.
- **A laptop sleeps when the lid closes.** Long-polling and scheduled reminders stop while asleep; reminders that came due are delivered immediately after wake or restart rather than being dropped.

---

## 2. Bind Your WeChat (Takes 1 Minute)

1. **Scan QR Code**: Open DSH, click **WeChat** in the left sidebar (or go to `Settings → Plugins → WeChat`), and click **Scan QR to Log In**.
2. **Set Default Working Directory (Optional)**: Open the **Gateway Options** tab and set `Working directory (cwd)` to your daily project or notes folder.
3. **Send Your First Message (Auto Owner Enrolment)**: By default, the plugin ignores everyone for safety. After scanning, **send the first message from your own WeChat** (e.g. `hello` or `/status`) — it will automatically register you as the owner.

---

## 3. Handy WeChat Slash Commands

These shortcuts are handled locally by the plugin without spending model tokens:

| Send in WeChat | What It Does |
| :--- | :--- |
| `/new` or `/new weekly report` | Start a new topic (previous conversations are kept) |
| `/list` | List your conversation history (`1, 2, 3...`) |
| `/use 2` | Switch back to conversation `#2` |
| `/cancel` | Immediately stop the currently running task |
| `/compact` | Compress context when a conversation gets long |
| `/status` | Check connection status and active topic |
| `/send <file-path>` | Have the Agent send a local file to your WeChat |
| `/help` | Show the command cheat sheet |

To deliver a file, ask the assistant to include its path in the reply, or use `/send <file-path>`. Only files inside allowed directories can be sent; the plugin does not scan the workspace and guess which files to deliver.

---

## 4. Instructions for AI Agents (Automated Install / Upgrade / Uninstall)

> **For AI Agents**: When the user asks you to install, update, or uninstall this plugin, run these steps directly.

### Install from Scratch
You need `git`, `node` (>= 22.13.0) and `pnpm`. **On macOS these are often not on PATH**: prefer the runtime bundled with DSH (`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node` and the sibling `pnpm/bin/pnpm.cjs`) instead of asking the user to install another Node.

Clone into a permanent directory (do **not** use `/tmp`, as `install.mjs` creates a persistent `link:` to this checkout):

```bash
git clone https://github.com/xrzhai/dsh-plugin-wechat.git
cd dsh-plugin-wechat
pnpm install
node bin/install.mjs --profile desktop
npm run doctor -- --offline
```
After running the installer, tell the user to **fully quit and restart DSH**, then open **WeChat** in the left sidebar to scan the QR code.

### Upgrade & Uninstall
```bash
# Upgrade
git pull && pnpm install && node bin/install.mjs --profile desktop

# Uninstall (unlinks from profile; keeps source checkout, credentials, and history)
node bin/install.mjs --profile desktop --uninstall
```

---

## 5. Acknowledgments & License

Built upon **[panqing0313](https://github.com/panqing0313)**'s pioneering [`dsh-plugin-weixin`](https://github.com/panqing0313/dsh-plugin-weixin) and Tencent's [`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) (MIT). Special thanks to **panqing0313** for the WeChat iLink transport bridge and multi-account foundation.

Released under the [MIT License](LICENSE).
