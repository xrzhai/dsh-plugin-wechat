<div align="center">

# dsh-plugin-wechat · WeChat Engineering Control Surface

**Turn your personal WeChat into a production-grade remote engineering control surface for DeepSeek Harness (DSH).**

Send a message from WeChat on your phone to wake and steer DSH Agents running on your workstation — two-way text, images, files, and local ASR voice transcription, ordered multi-turn Subagent delivery, and cross-project parallel session dispatching.

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

This project is an engineering-focused evolution of **[panqing0313](https://github.com/panqing0313)**'s pioneering open-source plugin [`dsh-plugin-weixin`](https://github.com/panqing0313/dsh-plugin-weixin).

We extend our sincere gratitude to **panqing0313** for establishing the non-intrusive WeChat iLink Bot API transport bridge (vendored from Tencent's MIT-licensed `@tencent-weixin/openclaw-weixin`), multi-account polling, local Whisper ASR bridge, and the comprehensive multi-tab Settings Card UI.

### Why This Evolution? (Fork Positioning)

- **Upstream ([`panqing0313/dsh-plugin-weixin`](https://github.com/panqing0313/dsh-plugin-weixin))**: Designed as a **full-featured companion chatbot**, complete with emotional memory injection, affinity curves, inferred life states, human-like bubble splitting delays, and character personas.
- **This Repository ([`xrzhai/dsh-plugin-wechat`](https://github.com/xrzhai/dsh-plugin-wechat))**: Designed as a **production-grade remote engineering control surface** for developers and researchers running heavy workflows on DSH 0.2.2+.

When DSH is used for long-running shell tasks, concurrent asynchronous Subagent orchestration, and multi-project parallel sessions, the gateway must guarantee **Zero Prompt Pollution**, **Zero Dropped Subagent Replies**, and **Safe Cross-Session Dispatching**:

| Dimension | Upstream Companion Edition (`dsh-plugin-weixin`) | Engineering Control Edition (`dsh-plugin-wechat`) | Core Engineering Guarantee |
| :--- | :--- | :--- | :--- |
| **Prompt Purity** | Prepends `<weixin_memory>`, `<weixin_life>`, etc. on every turn | **Zero Prompt Pollution** | Strips per-turn implicit XML wrappers; delegates instructions 100% to native `AGENTS.md` and prefix-cached Compaction |
| **Async Subagent Multi-Turn Delivery** | Single-cursor read; Turn $N+1$ overwrites Turn $N$ | **`readSettledTurns` ordered per-turn slicing** | Prevents trailing system `[SILENT]` turns (when a subagent exits) from swallowing the main Agent's substantive report |
| **Same-Turn Trailing Silent Recovery** | Checks only the final text of a turn | **`replyBeforeSilent` state-machine recovery** | Rescues a completed Step 1 reply (`finish(stop)`) when a subagent exit triggers a steered Step 2 `[SILENT]` within the same turn |
| **Parallel Session Dispatch** | Bound to a single isolated WeChat session line | **`SessionDispatcher` (`list / query / dispatch`)** | Inspect and control other active desktop project sessions (`followup`, `steer`, `cancel`) from WeChat under strict dual allowlists |
| **Code Block Delivery Fidelity** | Converts code blocks >1200 chars into file attachments | **Forces `richContent: false` plain-text chunking** | Ensures dispatched code & logs always arrive in full as text bubbles, never lost to CDN media upload failures |
| **8-Min Token TTL & Outbox Self-Healing** | Retries expired `context_token`; transient notes pile up as dead letters | **`sendToken()` refresh + `durable:false` + `prune()`** | Refreshes typing ticket after 8m for long turns; drops failed progress notes immediately; prunes exhausted dead letters |
| **Live Gateway Switch & Path Sandbox** | Toggling `enabled` may require restart; basic file checks | **`Live Gateway Switch` drain + `realpathSync` sandbox** | Hot-starts/stops polling on save while draining in-flight turns; blocks symlink traversal and deduplicates canonical paths |

---

## 2. Quick Start

### Option A: Install into DSH Profile from Source

```bash
git clone https://github.com/xrzhai/dsh-plugin-wechat.git
cd dsh-plugin-wechat
pnpm install
node bin/install.mjs --profile desktop
```

### Option B: Local Developer `link:` Mount

In `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dependencies": {
    "dsh-plugin-wechat": "link:D:/Projects/dsh-plugin-wechat"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-plugin-wechat"
      ]
    }
  }
}
```

> **Seamless Migration**: The internal Cordis row ID remains `dsh-weixin` and the state directory remains `~/.dsh/weixin/` (`0600`). Migrating from `dsh-plugin-weixin` preserves all logged-in WeChat accounts, allowlists, session lines, and preferences without re-scanning QR codes.

### Login & First-Contact Auto-Authorization

1. Open **Settings → Plugins → WeChat BOT** (or click **WeChat BOT** in the left sidebar) and click **Scan QR to Log In** (or run `npm run login` in terminal). No host restart required.
2. **Deny-by-default**: `allowedSenders` starts empty. The sender of the **first inbound message** on a newly bound account is automatically registered as the owner and allowed; all subsequent strangers are blocked until explicitly allowlisted.
3. **Health Check**:
   ```bash
   npm run onboard          # Readiness checklist (exit code 0 = ready)
   npm run doctor           # 13-point health check
   npm run doctor -- --fix  # Auto-fix directory permissions and stale temp files
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
- `/outbox` / `/outbox retry` — Inspect or retry durable outbound queue
- `/send <path>` — Send an allowed local file to WeChat

### Running the Test Suite

```bash
npm test                     # Run all 148 isolated unit & integration tests
npm run test:host-contract   # Verify host contract against installed DSH peer packages
```

## License

[MIT License](LICENSE) © 2026 panqing0313, xrzhai (mine), and contributors. Transport layer vendored from [`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) (MIT © 2026 Tencent).
