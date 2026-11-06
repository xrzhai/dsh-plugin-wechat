<div align="center">

<img src="assets/icon-128.png" width="72" alt="dsh-plugin-wechat" />

# dsh-plugin-wechat

**Control Your DeepSeek Harness Anytime from WeChat**

[**简体中文**](README.md) · [**MIT License**](LICENSE)

</div>

Chat with the **DeepSeek Harness (DSH)** running on your computer directly from WeChat on your phone when you are away from your desk:

- **Command from anywhere**: Send a message in WeChat to have your local Agent research, write code, edit docs, or run tasks, and receive results or files back in WeChat;
- **Follow delegated work**: While the plugin is running, follow-up replies received by the main session can be sent to the originating WeChat chat;
- **Local credentials**: The plugin stores account credentials on your machine (`~/.dsh/weixin/`); messages are processed by the DSH model and tool services you use.

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
- **A laptop sleeps when the lid closes.** The WeChat connection pauses while asleep and needs time to reconnect after waking.

---

## 2. Bind Your WeChat (Takes 1 Minute)

1. **Scan QR Code**: Open DSH, click **WeChat** in the left sidebar (or go to `Settings → Plugins → WeChat`), and click **Scan QR to Log In**.
2. **Set Default Working Directory (Optional)**: Open the **Gateway Options** tab and set `Working directory (cwd)` to your daily project or notes folder.
3. **Send Your First Message (Auto Owner Enrolment)**: If no sender list is configured, the plugin registers the first contact it actually receives. Send a message from your own WeChat (e.g. `hello` or `/status`) and check the allowed list: the first contact is not necessarily the person who scanned the code.

Incoming images, voice, video and files are saved locally and their paths are passed to the DSH Agent. Whether it can read or understand them depends on the available tools and model.

The plugin no longer runs built-in reminders or scheduled messages. Existing schedule data remains on disk but will not trigger.

---

## 3. Handy WeChat Slash Commands

These shortcuts are handled locally by the plugin without spending model tokens:

| Send in WeChat | What It Does |
| :--- | :--- |
| `/new` or `/new weekly report` | Start a new topic (previous conversations are kept) |
| `/list` | List your conversation history (`1, 2, 3...`) |
| `/use 2` | Switch back to conversation `#2` |
| `/clear` | Clear the topic list while keeping DSH history |
| `/cancel` | Request that the current reply stop; check child tasks separately |
| `/compact` | Compress context when a conversation gets long |
| `/status` | Check connection status and active topic |
| `/outbox`, `/outbox retry` | Check pending replies in this chat or retry them. Check what arrived first: retrying after a lost acknowledgement may send a duplicate. |
| `/send <file-path>` | Have the Agent send a local file to your WeChat |
| `/help` | Show the command cheat sheet |

To deliver a file, ask the assistant to include its path in the reply, or use `/send <file-path>`. Only files inside allowed directories can be sent; the plugin does not scan the workspace and guess which files to deliver.

Topics are separated by WeChat account and chat. After upgrading to source-isolated topics, old topic links are not migrated automatically; the original DSH session history remains in DSH.

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
