/**
 * Weixin/iLink state location for the DSH plugin.
 *
 * The vendored Tencent transport reads `OPENCLAW_STATE_DIR` (else `CLAWDBOT_STATE_DIR`,
 * else `~/.openclaw`) and lays out files under
 * `<stateDir>/openclaw-weixin/accounts/{accountId}.json` plus an index
 * `accounts.json`, and a long-poll cursor `<stateDir>/openclaw-weixin/accounts/{accountId}.sync.json`.
 *
 * dsh-weixin keeps the same layout (so the vendored code needs no patching) but
 * points the root at a DSH-owned directory, so credentials never land in a
 * directory some other OpenClaw install also writes. This module must therefore
 * set the environment variable BEFORE the vendored modules are imported — the
 * transport captures `process.env.OPENCLAW_STATE_DIR` per call
 * (`resolveStateDir()` re-reads env each time), so setting it once at apply time
 * is enough and is what {@link configureWeixinStateDir} does.
 * @module dsh-weixin/state
 */
import fs from 'node:fs'
import { readTextFileCached } from './atomic.js'
import os from 'node:os'
import path from 'node:path'

/** Override for tests and non-default profiles. */
const ENV_OVERRIDE = 'DSH_WEIXIN_STATE_DIR'

/**
 * Absolute path of the directory that acts as the OpenClaw state root.
 * Layout below it: `openclaw-weixin/accounts/<accountId>.json`,
 * `openclaw-weixin/accounts.json`, `openclaw-weixin/accounts/<accountId>.sync.json`.
 */
export function stateDir() {
  const override = process.env[ENV_OVERRIDE]?.trim()
  if (override) return path.resolve(override)
  return path.join(os.homedir(), '.dsh', 'weixin')
}

/**
 * Directory holding per-account credential files.
 */
export function accountsDir() {
  return path.join(stateDir(), 'openclaw-weixin', 'accounts')
}

/**
 * Working directory Weixin conversations run in.
 *
 * DSH groups a session by its working directory, so running these agents in the
 * deployment's own cwd would scatter them through the profile's session group,
 * indistinguishable from conversations the user started here. Giving Weixin its
 * own directory collects every Weixin conversation under one group.
 *
 * The directory is created by {@link ensureSessionsDir} at apply time because a
 * session cannot be created in a path that does not exist.
 */
export function sessionsDir() {
  return path.join(stateDir(), 'sessions')
}

/**
 * Create {@link sessionsDir} if needed and return it.
 *
 * Also seeds two files into the plugin's own workspace on first run:
 * a starter persona (AGENTS.md) and a starter memory note (memory.md). Without
 * them a brand-new user lands in an empty workspace and the assistant has no
 * voice and remembers nothing. Each seed is written only when the file is
 * absent, so an operator's own persona / memory is never overwritten.
 * @throws when the directory cannot be created, since an agent cannot run
 *   without a working directory.
 */
export function ensureSessionsDir() {
  const dir = sessionsDir()
  fs.mkdirSync(dir, { recursive: true })
  ensureDefaultAgentInstructions(dir)
  ensureDefaultMemoryFile(dir)
  return dir
}

/**
 * The starter persona for a fresh walkthrough.
 *
 * Kept short and behaviour-first: who it is, how it talks on a phone screen,
 * what it can do, and where its memory lives. Memory is a plain `memory.md`
 * the assistant reads when it needs to and edits when it learns something —
 * no always-injected memory engine.
 */
export const DEFAULT_AGENT_INSTRUCTIONS = `# 大肥鱼 · 微信里的远程调度师

你是「大肥鱼」，用户在微信里的远程调度师。接单、澄清、派活、跟进并交付结果；说话自然直接，别用客服腔。

## 说话方式
- 微信屏幕小：默认 1~3 个短段落，80~180 字，结论先行；不要长篇大论，不要堆表格和多层列表。
- 有温度，接得住情绪；除非用户说「展开讲讲」，只给最核心的判断。

## 怎么干活：控制面自己来，重活派子智能体
- **控制面与轻量动作自己调**：遥控本机其他普通 DSH 会话（用 session_list 找会话、用 session_query 查进度、用 session_dispatch 给运行中的任务 steer 补充指令或 cancel 请求停止、给空闲会话 followup 派后续任务）、管理子智能体（list_agents / send_message / interrupt_agent）、管理定时任务（schedule_*），以及读写同目录的 \`memory.md\`，都由你直接调用工具完成。
- **耗时重活派 subagent**：凡是跑终端命令/脚本、搜文件、读长文档、改代码或联网搜索等会产生大量输出或耗时的任务，优先调用 \`subagent\` 派子智能体去执行，避免长日志塞满微信主会话；等子任务完成后，由你提炼成几句人话汇报给用户。
- **发本机文件**：用户要收图或文件时，直接在回复里引用可读取的本机文件，微信网关会自动把它作为附件发出。优先用绝对路径：图片写 ![图](D:/Reports/chart.png)，文档写 [报告](<D:/Reports/季度 报告.pdf>)；也可以单独一行写不含空格的绝对路径。

## 你的记忆：memory.md
- 记性放在同目录的 \`memory.md\` 里。**按需读取**——要回忆用户偏好或称呼时再打开看，不用每轮都读全。
- 学到值得长期记住的事（称呼、喜好、忌讳、重要日子、约定），就主动补进 \`memory.md\`。
- 用户说「记住…」时也是写进 \`memory.md\`，不要另开一套记忆。

## 第一次聊天（重要）
当用户表示第一次使用，或主动问你是谁、能做什么时，简单介绍自己并先处理请求；不要把新话题当成第一次使用。需要了解称呼时，再按需查看 \`memory.md\`。

## 边界
- 只服务被授权的用户；不确定的操作先问，删除或对外发送前必须确认。
- 这个文件（AGENTS.md）是你的人设，只由用户在设置里维护，你不要改它。
`

/**
 * The starter memory note. It is data the assistant maintains, not instructions
 * the gateway injects — the persona tells the model to read it on demand. Kept
 * as a short fill-in template.
 */
export const DEFAULT_MEMORY_FILE = `# 大肥鱼 的记忆

> 这是大肥鱼自己维护的备忘。需要回忆用户偏好时按需读一读，学到新的事就补进来。

## 关于你
- 称呼：
- 作息 / 时区：
- 喜欢 / 不喜欢：
- 重要日子：

## 长期事项
-

## 大肥鱼 的笔记
-
`

function ensureDefaultAgentInstructions(dir) {
  const file = path.join(dir, 'AGENTS.md')
  try {
    if (fs.existsSync(file)) return
    fs.writeFileSync(file, DEFAULT_AGENT_INSTRUCTIONS, 'utf8')
  } catch {
    // A persona seed failure must never stop the workspace from being usable.
  }
}

function ensureDefaultMemoryFile(dir) {
  const file = path.join(dir, 'memory.md')
  try {
    if (fs.existsSync(file)) return
    fs.writeFileSync(file, DEFAULT_MEMORY_FILE, 'utf8')
  } catch {
    // A memory seed failure is cosmetic; never block the workspace.
  }
}

/**
 * Where inbound Weixin media (images, files, voice, video) is saved.
 *
 * Under the plugin's own state tree rather than a temp directory, for two
 * reasons: a decrypted attachment is the user's content and should not be swept
 * away by the OS mid-turn, and {@link sessionsDir}'s agents must be able to
 * `read` it, which the outbound media allowlist already admits
 * (`src/media/outbound.js` allows the whole state root).
 *
 * The directory is NOT created here — {@link ensureInboxDir} does that — because
 * this accessor is also used for a path comparison, and a comparison must not
 * have the side effect of creating a directory.
 */
export function inboxDir() {
  return path.join(stateDir(), 'media', 'inbound')
}

/**
 * Create {@link inboxDir} if needed and return it.
 * @throws when the directory cannot be created; an inbound attachment that
 *   cannot be stored is reported to the user as a download failure.
 */
export function ensureInboxDir() {
  const dir = inboxDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** File holding the operator's settings for this plugin. */
export function configFile() {
  return path.join(stateDir(), 'config.json')
}

/**
 * Read the operator's saved settings.
 *
 * This is a plain JSON file under the plugin's own state root, deliberately NOT
 * a profile YAML patch. A profile patch row would have to be *inserted* through
 * `cordis.patch.yml`, and this package is also installed as a bundle — whose own
 * patch layer already inserts the same row. Two insertions of one `id` produce
 * two loader entries, both of which mount, so the account gets two long-poll
 * loops. DSH's own `dsh-better-sidebar` documentation states the rule: a profile
 * still carrying the manual mount line must drop it before switching to the
 * bundle channel. Keeping the settings beside the credentials (which already
 * live under this state root) sidesteps the composition entirely.
 *
 * A missing file, unreadable file, or malformed JSON all resolve to `{}`: this
 * is a settings overlay, and a corrupt overlay must cost the user their
 * preferences, never the plugin's ability to load and reply.
 *
 * @returns {Record<string, unknown>} saved settings, possibly empty
 */
export function readSavedConfig() {
  const file = configFile()
  let text
  try {
    // Every inbound message rebuilds the effective config, so this read sits on
    // the hot path; the cache keys on mtime/size/ino and the card's writes go
    // through atomicWriteJson, which invalidates the entry.
    text = readTextFileCached(file)
  } catch {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    process.emitWarning(`dsh-weixin: ignoring malformed ${file}: ${String(error?.message ?? error)}`)
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.emitWarning(`dsh-weixin: ignoring ${file}: expected a JSON object`)
    return {}
  }
  return parsed
}

/**
 * Merge the operator's saved settings over the composition's own config.
 *
 * Precedence: the saved file written by the settings card is the newer
 * statement. A saved value wins unless it is the schema's empty form
 * (`undefined`, `''`, `[]`, `{}`); `false` and `0` are real values. An explicit
 * non-empty composition `allowedSenders` stays authoritative.
 *
 * Loader schema defaults must not overwrite explicit saved preferences.
 *
 * @param {Record<string, unknown>} config config as the loader passed it
 * @returns {Record<string, unknown>} config with the saved settings applied
 */
export function withSavedConfig(config) {
  const saved = readSavedConfig()
  const merged = { ...saved, ...config }
  // `allowedSenders` needs its own rule. The schemastery schema instantiates
  // every field, so a composition that never mentions the array still arrives
  // as `allowedSenders: []` — and spread-merge would let that default win over
  // the operator's saved allowlist, refusing every sender while the file on
  // disk looks perfectly configured (observed 2026-10-15: the refusal log said
  // `allowedSenders=[]` while config.json listed exactly one id). An empty
  // array from the composition cannot be distinguished from an explicit
  // deny-all, but the deny-all is already the behavior of an EMPTY SAVED FILE,
  // so a non-empty saved list always wins over an empty composition value.
  if (
    Array.isArray(merged.allowedSenders) &&
    merged.allowedSenders.length === 0 &&
    Array.isArray(saved.allowedSenders) &&
    saved.allowedSenders.length > 0
  ) {
    merged.allowedSenders = saved.allowedSenders
  }
  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  const isEmptyDefault = (value) =>
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (isPlainObject(value) && Object.keys(value).length === 0)

  // The same rule now applies to the top level: a saved value beats the
  // schema-instantiated default the loader passed. `allowedSenders` keeps the
  // rule above; `null` counts as "not set here", while `false` and
  // `0` are real values.
  for (const [key, savedValue] of Object.entries(saved)) {
    if (key === 'allowedSenders') continue
    if (savedValue === null || isEmptyDefault(savedValue)) continue
    merged[key] = savedValue
  }
  return merged
}

/**
 * Point the vendored transport at the DSH state directory.
 *
 * Must run before any call that resolves a credential or sync-buffer path. The
 * vendored `resolveStateDir()` prefers `OPENCLAW_STATE_DIR`, so exporting it is
 * the whole integration; `CLAWDBOT_STATE_DIR` is cleared so a stray value from
 * the environment cannot win.
 */
export function configureWeixinStateDir() {
  const dir = stateDir()
  process.env.OPENCLAW_STATE_DIR = dir
  delete process.env.CLAWDBOT_STATE_DIR
  return dir
}
