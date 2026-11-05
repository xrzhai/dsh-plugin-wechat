<div align="center">

# dsh-plugin-wechat · WeChat Engineering Control Surface

**Turn your personal WeChat into a production-grade remote engineering control surface for DeepSeek Harness (DSH).**

Send a message from WeChat on your phone to wake and steer DSH Agents running on your workstation — two-way text, images, and files, ordered multi-turn Subagent delivery, and cross-project parallel session dispatching.

![Node.js >= 22.13.0](https://img.shields.io/badge/node-%3E%3D22.13.0-339933?logo=node.js&logoColor=white)
![DSH >= 0.2.2](https://img.shields.io/badge/DSH-0.2.2%2B-4D6BFE)
![Zero Prompt Pollution](https://img.shields.io/badge/Prompt-Zero_Pollution-10B981)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[简体中文](README.md) ｜ **English**

<img src="assets/icon-128.png" width="80" alt="dsh-plugin-wechat icon" />

</div>

<img src="assets/hero.png" alt="Commanding a local DSH Agent from WeChat" />

---

## 1. Positioning & Acknowledgment

This project is an engineering-focused evolution of **[panqing0313](https://github.com/panqing0313)**'s pioneering open-source plugin [`dsh-plugin-weixin`](https://github.com/panqing0313/dsh-plugin-weixin). **This repository is a self-contained standalone package (bundling the plugin core, UI, installer, and vendored WeChat iLink transport) — you only need this repository and a configured DSH installation, without installing the upstream plugin first.**

We extend our sincere gratitude to **panqing0313** for establishing the non-intrusive WeChat iLink Bot API transport bridge (vendored from Tencent's MIT-licensed `@tencent-weixin/openclaw-weixin`), multi-account polling, and the Settings Card UI.

### Why This Evolution? (Fork Positioning)

- **Upstream ([`panqing0313/dsh-plugin-weixin`](https://github.com/panqing0313/dsh-plugin-weixin))**: Designed as a **full-featured companion chatbot**, complete with emotional memory injection, affinity curves, inferred life states, human-like bubble splitting delays, and character personas.
- **This Repository ([`xrzhai/dsh-plugin-wechat`](https://github.com/xrzhai/dsh-plugin-wechat))**: Designed as a **production-grade remote engineering control surface** for developers and researchers running heavy workflows on DSH 0.2.2+.

| Dimension | Upstream Companion Edition (`dsh-plugin-weixin`) | Engineering Control Edition (`dsh-plugin-wechat`) | Core Engineering Guarantee |
| :--- | :--- | :--- | :--- |
| **Prompt Purity** | Prepends `<weixin_memory>`, `<weixin_life>`, etc. on every turn | **Zero Prompt Pollution** | Strips per-turn implicit XML wrappers; delegates instructions 100% to native `AGENTS.md` and prefix-cached Compaction |
| **Async Subagent Multi-Turn Delivery** | Single-cursor read; Turn $N+1$ overwrites Turn $N$ | **`readSettledTurns` ordered per-turn slicing** | Prevents trailing system `[SILENT]` turns (when a subagent exits) from swallowing the main Agent's substantive report |
| **Same-Turn Trailing Silent Recovery** | Checks only the final text of a turn | **`replyBeforeSilent` state-machine recovery** | Rescues a completed Step 1 reply (`finish(stop)`) when a subagent exit triggers a steered Step 2 `[SILENT]` within the same turn |
| **Parallel Session Dispatch** | Bound to a single isolated WeChat session line | **`SessionDispatcher` (`list / query / dispatch`)** | Inspect and control other active desktop project sessions (`followup`, `steer`, `cancel`) from WeChat under strict dual allowlists |
| **Code Block Delivery Fidelity** | Converts code blocks >1200 chars into file attachments | **Forces `richContent: false` plain-text chunking** | Ensures dispatched code & logs always arrive in full as text bubbles, never lost to CDN media upload failures |
| **Inbound Durability & Crash Safety** | In-memory consumption; restarts can drop pending work | **`inbound-pending` journal before cursor advance** | Unstarted messages recover on restart; interrupted in-flight turns log a warning without auto-rerunning side-effecting commands |
| **Outbound Breakpoint Resume & Token TTL** | Resends full text; retries expired `context_token`; transient notes pile up | **Segment resume (At-least-once) + 8m refresh + `durable:false`** | Tracks sent segments to resume from breakpoint; refreshes typing ticket after 8m; drops failed progress notes immediately |
| **Control Panel & Live Gateway Switch** | 13 general tabs; RPC errors shown as logged-out | **Focused 4-Tab Engineering UI + `Live Gateway Switch`** | Focuses on Accounts, Sessions, Workspace Instructions (`AGENTS.md`), and Gateway Options; hot-starts/stops polling while draining turns |

---

## 2. Quick Start (Install, Bind, Upgrade & Uninstall)

### 2.1 Prerequisites
1. Install and launch DSH at least once (default profile: `desktop`), configure a model, and verify desktop chat works.
2. Install Git, Node.js **>= 22.13.0**, and `pnpm`.
3. Finish active DSH tasks and exit DSH before installing or upgrading.

### 2.2 Clone & Install

In a directory where you intend to keep the checkout:

```bash
git clone https://github.com/xrzhai/dsh-plugin-wechat.git
cd dsh-plugin-wechat
pnpm install
node bin/install.mjs --profile desktop
```

The installer validates runtime dependencies, registers `dsh-plugin-wechat` (`link:` dependency + bundle entry) in the target profile, and cleans up legacy mounts (pass `--pin` if your profile uses a frozen lockfile).

> **Seamless Migration**: The internal Cordis row ID remains `dsh-weixin` and the state directory remains `~/.dsh/weixin/` (`0600`). Migrating from `dsh-plugin-weixin` preserves all bound WeChat accounts, allowlists, session lines, and preferences without re-scanning QR codes.

### 2.3 Bind WeChat & Verify

1. Reopen DSH and open **Settings → Plugins → WeChat BOT** (or click **WeChat BOT** in the left sidebar).
2. In **Gateway Options**, set the default working directory (`cwd`) to your project path.
3. In **WeChat Accounts**, click **Scan QR to Log In** (or run `npm run login` in terminal).
4. **Send the first message yourself**: `allowedSenders` starts empty (deny-by-default). The sender of the first inbound message on a newly bound account is automatically enrolled as the owner. Send `/status` and a test question to verify connectivity.
   - If the UI reports a connection error, click **Retry** or restart DSH; only rescan when it explicitly reports an expired session.

```bash
npm run onboard            # Readiness checklist
npm run doctor -- --offline # 13-point offline health check
```

### 2.4 Upgrade & Uninstall

```bash
# Upgrade (exit DSH first)
git pull && pnpm install && node bin/install.mjs --profile desktop

# Uninstall (unlinks from profile while keeping this checkout, credentials, and history)
node bin/install.mjs --profile desktop --uninstall
```

---

## 3. Slash Commands & Verification

All slash commands are intercepted locally without spending model tokens (except `/compact`, which triggers native DSH context compaction):

- `/new [title]` — Start a fresh DSH session line (previous sessions are preserved)
- `/list` or `/sessions` — List session lines for the current account
- `/use <index>` — Switch to an existing session line
- `/cancel` — Immediately abort the currently running Agent turn
- `/compact` — Trigger native DSH context compaction
- `/status` — Show connection status, active session line, and allowlist source
- `/diag` / `/diag export` — Self-diagnostic report / redacted troubleshooting bundle
- `/outbox` / `/outbox retry` — Inspect or retry durable outbound queue (resumes from unsent segments)
- `/send <path>` — Send an allowed local file to WeChat

### Running the Test Suite

```bash
npm test                     # Run all 196 sandboxed unit & integration tests
npm run test:host-contract   # Verify host contract against installed DSH peer packages
npm run check                # Static checks and dependency verification
```

### Design Documentation
- [Parallel Session Dispatcher (`docs/session-dispatcher.md`)](docs/session-dispatcher.md)
- [Same-Turn Silent Reply Recovery (`docs/silent-reply-recovery.md`)](docs/silent-reply-recovery.md)
- [Queue Concurrency, File Sandbox & Live Gateway Switch (`docs/validation-issues-23-25.md`)](docs/validation-issues-23-25.md)

## License

[MIT License](LICENSE) © 2026 panqing0313, xrzhai (mine), and contributors. Transport layer vendored from [`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) (MIT © 2026 Tencent).
