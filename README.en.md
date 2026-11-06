<div align="center">

<img src="assets/icon-128.png" width="72" alt="dsh-plugin-wechat" />

# dsh-plugin-wechat

**Control Your DeepSeek Harness Anytime from WeChat**

[**简体中文**](README.md) · [**MIT License**](LICENSE)

</div>

Step away from your desk and keep using **DeepSeek Harness (DSH)** right from WeChat on your phone:

- **Assign tasks and exchange local files**: Send text, voice notes, images, or documents from WeChat to have DSH research, write code, or draft reports. Need a file from your computer? Just ask *"Send me the report on my desktop"* or send `/send <file-path>`.
- **Background subagents report back automatically**: When a task takes time, your assistant delegates it to background subagents, acknowledges right away, and pushes the final result to your WeChat as soon as it finishes.
- **Check and direct other desktop DSH sessions**: Ask *"How far did the weekly report session get?"*, *"Ask it to fix the failing test"*, or *"Stop that task for now."* Works out of the box for the account owner—no need to copy session IDs or configure complex allowlists.

---

## 1. One-Minute Install

Send this prompt to DSH on your computer and let it install the plugin for you:

```text
Please install this WeChat plugin by following the Agent installation guide in its README: https://github.com/xrzhai/dsh-plugin-wechat
```

Once installed, **fully quit and reopen DSH**.

---

## 2. Connect WeChat

1. Open **WeChat** in the DSH left sidebar (or **Settings → WeChat**), go to **WeChat Account**, and click **Scan QR code to log in**.
2. Send `"hello"` or `/status` from your own WeChat first. The plugin automatically registers the first sender as the account owner and ignores strangers.
3. **Optional setup**:
   - Open **Persona** to customize how your assistant speaks and works.
   - Open **Advanced → Basics** to pick a default working folder for your projects.

---

## 3. Daily Usage

Just talk to it in plain language:

- **Find other desktop tasks**: *"List recent DSH sessions and find the one writing the weekly report."*
- **Direct a session**: *"Check if that session hit any errors"*, *"Have it add unit tests"*, or *"Stop that running session."*
- **Fetch a local file**: *"Send me `D:\Projects\report.pdf`."*

If you only want a standalone chat assistant and don't want WeChat to touch other desktop sessions, toggle off **Advanced → View and manage DSH sessions**. See [Session Dispatcher](docs/session-dispatcher.md) and [Security Notes](docs/security.md) for optional fine-grained restrictions.

### Quick Commands

These slash commands are handled directly by the plugin without spending model tokens (`/list` shows topics inside this WeChat chat; ask in natural language to list other desktop DSH sessions):

| Send in WeChat | What It Does |
| :--- | :--- |
| `/new` or `/new weekly report` | **Start a new topic** (previous topics are kept so you can switch back anytime) |
| `/list` | **List WeChat topics** (`1, 2, 3...`) |
| `/use 2` | **Switch back to topic `#2`** |
| `/cancel` | **Stop the current reply** |
| `/compact` | **Compress context** when a conversation gets long |
| `/send <file-path>` | **Send a file** from your computer to your WeChat |
| `/status` | **Check connection status** and active topic |
| `/outbox` or `/outbox retry` | **Check or resend** replies held up by network hiccups |
| `/clear` | **Clear the WeChat topic list** (DSH session history stays intact) |
| `/help` | **Show the command cheat sheet** |

---

## 4. Troubleshooting

- **Can't connect or login expired?**
  Make sure to fully quit and reopen DSH after installing or updating. If your WeChat session expires, scan a fresh QR code under **WeChat Account**.
- **No replies after closing the laptop lid?**
  Network and processes pause while your computer sleeps. It will reconnect automatically once the machine wakes up.
- **How do I update?**
  Tell DSH on your computer: *"Update the WeChat plugin to the latest version"*, then restart DSH.

---

## 5. Agent Installation Guide

Clone into a permanent directory (DSH links directly to this checkout). Requires Git, Node ≥ 22.13.0, and pnpm. On macOS, use DSH's bundled runtime if `node` or `pnpm` isn't on your terminal `PATH`. Replace `desktop` with the active profile name if different:

```sh
git clone https://github.com/xrzhai/dsh-plugin-wechat.git
cd dsh-plugin-wechat
pnpm install
node bin/install.mjs --profile desktop
npm run doctor -- --offline
```

- **Update**: Run `git pull` in the checkout, then re-run `pnpm install`, `node bin/install.mjs --profile desktop`, and `npm run doctor -- --offline`. Remind the user to fully restart DSH.
- **Uninstall**: Run `node bin/install.mjs --profile desktop --uninstall` (credentials and chat history remain in `~/.dsh/weixin/`).

---

## 6. Credits & License

Built upon [panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin) and [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin). Released under the [MIT License](LICENSE).
