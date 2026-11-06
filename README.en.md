<div align="center">

<img src="assets/icon-128.png" width="72" alt="dsh-plugin-wechat" />

# dsh-plugin-wechat

**Control Your DeepSeek Harness Anytime from WeChat**

[**简体中文**](README.md) · [**MIT License**](LICENSE)

</div>

Use **DeepSeek Harness (DSH)** on your computer from WeChat on your phone:

- **Assign work and exchange files**: Send DSH a document from WeChat and ask it to research, edit code or write a report. Ask “Send me the report on my desktop” to get a regular file your computer can read.
- **Follow background tasks**: While the plugin is running, it can forward updates that delegated tasks send to the main session.
- **Check and direct other DSH sessions on your desktop**: Ask “How far did the report session get?” or “Stop that task for now.” This works by default. Describe the project or task; there’s no need to copy a session ID.

## 1. Install

Send this to DSH on your computer:

```text
Please install this WeChat plugin by following the Agent installation guide in its README: https://github.com/xrzhai/dsh-plugin-wechat
```

After installation, **fully quit and reopen DSH**.

## 2. Connect WeChat

1. In the DSH sidebar, open **WeChat → WeChat Account → Scan QR code to log in** and scan the code with your phone.
2. If no sender list is configured, send “hello” or `/status` from your own WeChat first. The first contact to send a message becomes the owner. Check that contact under **WeChat Account**.
3. Edit **Persona** to change how the assistant works. To choose a project folder, set **Working directory** under **Advanced → Basics**. Leave it blank to use the plugin’s own workspace.

## 3. Use it from WeChat

Try “List recent DSH sessions and find the one writing the weekly report.” Once you’ve identified it, ask for progress, add instructions to a running task, request a stop, or give an idle session more work. Archived sessions are read-only. If your host can’t resume a historical session, open it on the desktop first.

By default, contacts allowed to chat through the current account can manage ordinary local DSH sessions. To turn that off, open **Advanced → View and manage DSH sessions**. To restrict access by contact, session or workspace, see the [dispatcher configuration](docs/session-dispatcher.md).

The plugin handles these shortcuts without using model tokens. `/list` shows topics in this WeChat chat; ask in plain language to find other desktop sessions.

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

To receive a file, ask the assistant to include its path in the reply, or send `/send <file-path>`. By default, regular files the assistant can read may be sent from any folder. The owner has no message rate limit by default. See [security boundaries](docs/security.md) for file size, credentials and access details.

## 4. Troubleshooting

- **Connection failed or login expired?** Fully restart DSH after installing or updating. If login expired, scan a new code under **WeChat Account**.
- **No replies with the laptop lid closed?** The connection pauses while the computer sleeps. Allow time to reconnect after waking.
- **Need an update?** Ask DSH to update the WeChat plugin, then restart DSH.

## 5. Agent installation guide

Use a permanent directory: DSH links to this checkout. You need Git, Node ≥ 22.13.0 and pnpm. On macOS, use DSH’s bundled runtime if Node or pnpm is missing from your terminal. Replace `desktop` with the user's profile name if needed.

```sh
git clone https://github.com/xrzhai/dsh-plugin-wechat.git
cd dsh-plugin-wechat
pnpm install
node bin/install.mjs --profile desktop
npm run doctor -- --offline
```

To update, run `git pull` in the checkout and repeat the install and offline check. Fully restart DSH afterward. To uninstall, run `node bin/install.mjs --profile desktop --uninstall`; credentials and chat history stay on disk.

## 6. Credits and license

Based on [panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin) and [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin). [MIT License](LICENSE).
