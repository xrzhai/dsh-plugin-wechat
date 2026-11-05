// ConfigController — the settings page's view of every configurable option.
//
// The plugin's options live in two places: the composition's Config schema (a
// profile YAML patch or the bundle row) and a JSON overlay at
// `<state>/config.json`. Before this service existed, the card could only edit
// the handful of ASR fields it happened to know about, so every other option --
// the sender allowlist, the message-length cap, the busy-message policy, the
// media size limits -- was reachable only by hand-editing JSON. This service
// turns the whole schema into something a form can render and write back.
//
// The field list below is the single source of truth for the UI. It is
// deliberately data, not code: the card renders whatever it is handed, so
// adding an option here is enough to make it editable, and the labels live next
// to the validation that reads them.
import fs from "node:fs";
import path from "node:path";
import { TypertRemoteService, RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { stateDir, readSavedConfig, configFile } from "./state.js";
import { remoteMethods } from "./typert-js.js";

/** Shape declarations the card understands. `number` carries min/max/step. */
const T = {
  boolean: "boolean",
  string: "string",
  text: "text", // multi-line string
  number: "number",
  stringList: "stringList", // one entry per line
  enum: "enum",
};

/**
 * Every configurable option, grouped for display.
 *
 * `path` is the address inside the config object, which is also the address the
 * saved overlay uses. `default` mirrors the schema in `src/index.js`; it is
 * repeated here rather than imported because the schema's `.default()` sits
 * behind schemastery's own wrapper, and a form that cannot say "this value is
 * the default" cannot offer a reset.
 */
export const FIELDS = [
  {
    group: "平行会话调度", groupEn: "Parallel Session Dispatcher",
    fields: [
      { path: "sessionDispatcherEnabled", type: T.boolean, default: false,
        label: "启用平行会话调度", labelEn: "Enable session dispatcher",
        hint: "默认关闭。开启后，下方单独授权的微信发送者可读取下方授权的项目会话并派发任务；不用于隔离不可信用户。保存后，下一条微信消息起生效。",
        hintEn: "Off by default. Explicitly listed senders can read authorized host sessions and send tasks. Changes take effect on your next WeChat message." },
      { path: "sessionDispatcherSenders", type: T.stringList, default: [], emptyMeansAll: false,
        label: "调度者发送者 ID", labelEn: "Dispatcher sender IDs",
        hint: "每行一个，须同时在网关发送者白名单中。空列表拒绝所有调度读取和写入。",
        hintEn: "One sender ID per line; must also be gateway-allowed. Empty denies all dispatcher access." },
      { path: "sessionDispatcherTargets", type: T.stringList, default: [], emptyMeansAll: false,
        label: "允许访问的目标会话 ID", labelEn: "Allowed target session IDs",
        hint: "每行一个精确会话 ID。空列表拒绝所有目标，无通配符。上方授权的调度者共享此名单；请只授予同一信任范围的用户。",
        hintEn: "Exact session IDs, one per line. Empty denies all, no wildcard. All authorized dispatcher senders share this target list." },
      { path: "protectedSessions", type: T.stringList, default: [],
        label: "只读会话 ID", labelEn: "Protected session IDs",
        hint: "每行一个；仍允许读取，但拒绝 followup、steer 和 cancel。",
        hintEn: "Readable, but followup, steer and cancel are refused." },
      { path: "readOnlyPaths", type: T.stringList, default: [],
        label: "只读工作区根目录", labelEn: "Read-only workspace roots",
        hint: "每行一个绝对路径；包括子目录与符号链接别名。仅约束调度工具，不是文件系统沙箱。",
        hintEn: "Absolute roots, including descendants and symlink aliases. Dispatcher policy, not a filesystem sandbox." },
    ],
  },
  {
    group: "基本与模型路由",
    groupEn: "Basics & Model Routing",
    fields: [
      {
        path: "enabled",
        type: T.boolean,
        default: true,
        label: "启用微信网关",
        labelEn: "Enabled",
        hint: "关闭后暂停接收新的微信消息；正在处理中的任务仍会完成并回复。",
        hintEn: "Turning this off pauses new WeChat messages; tasks already in progress can still finish and reply.",
      },
      {
        path: "cwd",
        type: T.string,
        default: "",
        label: "默认工作目录 (cwd)",
        labelEn: "Working directory",
        hint: "微信会话默认工作的目录（如 D:\\Workspace），自动加载该目录下的 AGENTS.md。",
        hintEn: "Directory the agent operates in.",
      },
      {
        path: "chatProvider",
        type: T.string,
        default: "",
        label: "主对话 Provider",
        labelEn: "Chat provider",
        hint: "主对话使用的 Provider（如 magpie）；留空沿用 DSH 默认模型。",
        hintEn: "Provider for the primary conversation.",
      },
      {
        path: "chatModel",
        type: T.string,
        default: "",
        label: "主对话 Model",
        labelEn: "Chat model",
        hint: "主对话的模型 ID（如 auto/gemini-3.8-flash）。",
        hintEn: "Model ID for the primary conversation.",
      },
      {
        path: "sideProvider",
        type: T.string,
        default: "",
        label: "后台任务 Provider",
        labelEn: "Background task provider",
        hint: "后台任务使用的 Provider（如定时主动消息、群聊摘要）。留空后仍会检查旧版用途路由；若仍无可用后台路由，则使用 DSH 默认模型。",
        hintEn: "Provider for background tasks such as scheduled messages and group summaries. Empty still allows legacy purpose routes to be checked; if no background route remains, the DSH default model is used.",
      },
      {
        path: "sideModel",
        type: T.string,
        default: "",
        label: "后台任务 Model",
        labelEn: "Background task model",
        hint: "后台任务的模型 ID；需要与上方 Provider 同时填写。",
        hintEn: "Model ID for background tasks; fill this together with the provider above.",
      },
    ],
  },
  {
    group: "消息与传输",
    groupEn: "Messages & Delivery",
    fields: [
      {
        path: "busyMessageMode",
        type: T.enum,
        default: "steer",
        options: [
          { value: "steer", label: "直接补充给当前任务 (steer)", labelEn: "Add to the current task (steer)" },
          { value: "queue", label: "排队，等当前任务完成后处理 (queue)", labelEn: "Queue until the current task finishes (queue)" },
        ],
        label: "忙碌时新消息处理",
        labelEn: "When busy",
        hint: "当前回合尚未结束时收到新微信消息的处理方式。",
        hintEn: "What happens to a message arriving mid-reply.",
      },
      {
        path: "markdownMode",
        type: T.enum,
        default: "strip",
        options: [
          { value: "strip", label: "转换为纯文本", labelEn: "Strip unsupported syntax" },
          { value: "off", label: "原样发送", labelEn: "Send verbatim" },
        ],
        label: "Markdown 处理",
        labelEn: "Markdown",
        hint: "微信气泡不渲染 Markdown，默认自动转为干净纯文本。",
        hintEn: "Convert Markdown syntax to clean plain text for WeChat.",
      },
      {
        path: "maxMessageLength",
        type: T.number,
        default: 1500,
        min: 100,
        max: 100_000,
        step: 100,
        unit: "字符",
        unitEn: "characters",
        label: "单条消息分段上限",
        labelEn: "Max message length",
        hint: "超过该长度的长回复会自动分段发送。",
        hintEn: "Longer replies are split into chunks.",
      },
      {
        path: "typingIndicator",
        type: T.boolean,
        default: true,
        label: "显示「正在输入」状态",
        labelEn: "Typing indicator",
        hint: "处理消息期间在微信顶部显示对方正在输入。",
        hintEn: "Show typing indicator in WeChat while running.",
      },
      {
        path: "autoSendFiles",
        type: T.boolean,
        default: false,
        label: "自动推送新生成交付物文件",
        labelEn: "Auto-send produced deliverable files",
        hint: "默认关闭；开启后也仅限白名单交付物（.pdf/.docx/.xlsx/.png 等），绝不发送 .json/.log。",
        hintEn: "Off by default; only whitelisted deliverables are ever sent.",
      },
    ],
  },
  {
    group: "权限",
    groupEn: "Access",
    fields: [
      {
        path: "allowedSenders",
        type: T.stringList,
        default: [],
        label: "允许的发送者 ID 白名单",
        labelEn: "Allowed senders",
        hint: "每行一个微信用户 ID，仅白名单内的用户可驱动 Agent。",
        hintEn: "One WeChat user id per line.",
        emptyMeansAll: false,
      },
      {
        path: "allowedChats",
        type: T.stringList,
        default: [],
        label: "允许的会话 ID",
        labelEn: "Allowed conversations",
        hint: "可选；留空表示允许上述白名单发送者的任何私聊会话。",
        hintEn: "Optional conversation allowlist.",
        emptyMeansAll: true,
      },
    ],
  },
];

/** Flat field list, for lookups by path. */
const FIELD_BY_PATH = new Map()
for (const group of FIELDS) {
  for (const field of group.fields) FIELD_BY_PATH.set(field.path, field)
}

/** Read `a.b` out of a nested object, without throwing on a missing parent. */
function readPath(object, dotted) {
  const parts = dotted.split(".")
  let cursor = object
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = cursor[part]
  }
  return cursor
}

/** Write `a.b` into a nested object, creating intermediate objects. */
function writePath(object, dotted, value) {
  const parts = dotted.split(".")
  let cursor = object
  for (const part of parts.slice(0, -1)) {
    if (cursor[part] === null || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      cursor[part] = {}
    }
    cursor = cursor[part]
  }
  cursor[parts.at(-1)] = value
}

/**
 * Coerce one submitted value into what the schema expects.
 *
 * The form sends strings for everything (a text input has no other type), so
 * this is where "1500" becomes the number 1500 and "true" becomes a boolean.
 * A value that cannot be coerced raises a RemoteError naming the field, because
 * silently writing a string where a number belongs would make the plugin fail
 * at message time instead of at save time.
 *
 * @returns {unknown} the value to store, or `undefined` to mean "clear it"
 */
function coerce(field, raw, t) {
  if (field.type === T.boolean) {
    if (typeof raw === 'boolean') return raw
    const text = String(raw ?? '').trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'on') return true
    if (text === 'false' || text === '0' || text === 'off' || text === '') return false
    throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：需要一个开关值`, {})
  }
  if (field.type === T.number) {
    const text = String(raw ?? '').trim()
    if (!text) return undefined // empty means "use the default"
    const value = Number(text)
    if (!Number.isFinite(value)) {
      throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：需要一个数字，收到「${text}」`, {})
    }
    if (field.min !== undefined && value < field.min) {
      throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：不能小于 ${field.min}`, {})
    }
    if (field.max !== undefined && value > field.max) {
      throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：不能大于 ${field.max}`, {})
    }
    return value
  }
  if (field.type === T.stringList) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split('\n')
    return list.map((entry) => String(entry).trim()).filter((entry) => entry !== '')
  }
  if (field.type === T.enum) {
    const text = String(raw ?? '').trim()
    if (!field.options.some((option) => option.value === text)) {
      throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：不是可选的取值`, {})
    }
    return text
  }
  if (field.type === T.string) {
    const text = String(raw ?? '')
    // An emptied box means "no value of mine", not "the empty string". For a
    // field whose default IS empty (`accountId`, `cwd`, the ASR bridge) storing
    // "" would be indistinguishable from unset in behavior but not in the
    // report: the form would say "saved" where it should say "default". For a
    // field whose default is NOT empty (`asr.hfEndpoint`) an empty box is
    // ambiguous, and clearing the override is the reading that lets an operator
    // get back to the default, so a reset is always available from the form.
    if (text.trim() === '' && field.default === '') return undefined
    return text
  }
  if (field.format === 'env') {
    // Stored as an object, edited as KEY=VALUE lines.
    const result = {}
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split('\n')
    for (const line of list) {
      const text = String(line).trim()
      if (!text || text.startsWith('#')) continue
      const eq = text.indexOf('=')
      if (eq <= 0) {
        throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：每行需要是 KEY=VALUE，收到「${text}」`, {})
      }
      result[text.slice(0, eq).trim()] = text.slice(eq + 1)
    }
    return result
  }
  return String(raw ?? '')
}

/** Render a stored value back into the text the form shows. */
function present(field, value) {
  if (field.format === 'env' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value)
      .map(([key, val]) => `${key}=${val}`)
      .join('\n')
  }
  if (field.type === T.stringList) {
    return Array.isArray(value) ? value.join('\n') : ''
  }
  if (value === undefined || value === null) return ''
  if (field.type === T.boolean) return value === true
  return String(value)
}

/**
 * Which keys this service may write.
 *
 * `maxTurnWaitMs` is absent on purpose: it is a safety bound on how long a turn
 * may run, and lowering it from a form is how an operator silently truncates
 * long replies. It stays in the file for anyone who wants it, and the form
 * reports its effective value without offering an editor.
 */
const READ_ONLY = new Set(['maxTurnWaitMs'])

export class ConfigController extends TypertRemoteService {
  constructor(ctx, options = {}) {
    super(ctx, "configController", { namespace: "weixinConfig" })
    // The composition's config, so the form can show effective values rather
    // than only what the overlay says. Saved values win for display, since they
    // are what the running plugin actually uses.
    this.config = options.config ?? {}
  }

  /**
   * The whole form: every field, its effective value, and where that came from.
   *
   * `source` matters more than it looks. A value can come from this form, from a
   * profile YAML patch, or from the schema default, and the three behave
   * differently when the overlay is cleared -- an operator who cannot tell them
   * apart will file a bug the first time a reset "does nothing".
   */
  async list() {
    const saved = readSavedConfig()
    const groups = FIELDS.map((group) => ({
      group: group.group,
      groupEn: group.groupEn,
      fields: group.fields.map((field) => {
        const savedValue = readPath(saved, field.path)
        const configValue = readPath(this.config, field.path)
        const hasSaved = savedValue !== undefined
        const hasConfig = configValue !== undefined && configValue !== ''
        const effective = hasSaved ? savedValue : hasConfig ? configValue : field.default
        let source = 'default'
        if (hasSaved) source = 'saved'
        else if (hasConfig) source = 'config'
        return {
          path: field.path,
          type: field.type,
          label: field.label,
          labelEn: field.labelEn,
          hint: field.hint,
          hintEn: field.hintEn,
          value: present(field, effective),
          defaultValue: present(field, field.default),
          source,
          readOnly: READ_ONLY.has(field.path),
          // Secrets are never exported. The former prompt-star annotation was
          // removed with the prompt tab it pointed to.
          secret: field.secret === true,
          options: field.options ?? undefined,
          min: field.min,
          max: field.max,
          step: field.step,
          unit: field.unit,
          unitEn: field.unitEn,
          // An empty allowlist means "refuse everyone" for senders and "allow
          // all" for chats: opposite meanings, so the card must not render one
          // generic "empty means all" note for both.
          emptyMeansAll: field.emptyMeansAll,
        }
      }),
    }))
    return { groups, configFile: configFile(), stateDir: stateDir() }
  }

  /**
   * Write a batch of edits into the saved overlay.
   *
   * Takes a list rather than one field per call so the form can save a whole
   * section with one write: several round trips would leave the file briefly
   * half-updated, and a failure halfway through would be hard to describe.
   *
   * Every value is validated BEFORE anything is written, so a bad field in the
   * middle of a batch cannot leave the earlier ones applied -- the caller gets
   * one error and the file is untouched.
   */
  async save(entriesJson, lang) {
    const t = (zh, en) => (lang === 'en' ? en : zh)
    // The batch arrives as a JSON string rather than a structured array.
    // The remote wire validates parameters against a declared codec, and the
    // plugin's codec vocabulary (string/number/record/unknown) has no array
    // node -- so an array parameter would be rejected at the gateway before
    // this method ever ran. A JSON string uses the codec that already exists.
    let entries
    try {
      entries = typeof entriesJson === 'string' ? JSON.parse(entriesJson) : entriesJson
    } catch (error) {
      throw new RemoteError('bad_request', t('无法解析要保存的内容', 'Could not parse the values to save'), {})
    }
    if (!Array.isArray(entries)) {
      throw new RemoteError('bad_request', t('缺少要保存的内容', 'Missing the values to save'), {})
    }
    const patch = {}
    for (const entry of entries) {
      const dotted = String(entry?.path ?? '')
      const field = FIELD_BY_PATH.get(dotted)
      if (field === undefined) {
        throw new RemoteError('unknown_field', t(`未知的配置项：${dotted}`, `Unknown option: ${dotted}`), {})
      }
      if (READ_ONLY.has(dotted)) {
        throw new RemoteError('read_only', t(`${t(field.label, field.labelEn)} 不能在界面上修改`, `${t(field.label, field.labelEn)} cannot be edited here`), {})
      }
      const value = coerce(field, entry?.value, t)
      // `undefined` from coerce means "the operator cleared the box": remove the
      // key rather than storing a null, so the schema default applies again.
      if (value === undefined) {
        deletePath(patch, dotted)
        markClear(patch, dotted)
        continue
      }
      writePath(patch, dotted, value)
    }
    const saved = readSavedConfig()
    const next = { ...saved }
    applyPatch(next, patch)
    for (const cleared of clearedPaths(patch)) {
      deletePath(next, cleared)
    }
    writeSavedConfig(next)
    await this.onConfigChanged?.()
    return this.list()
  }

  /** Put one field (or everything) back to the schema default. */
  async reset(pathsJson) {
    // Same wire constraint as `save`: a list travels as a JSON string.
    let paths = pathsJson
    if (typeof pathsJson === 'string') {
      try {
        paths = JSON.parse(pathsJson)
      } catch {
        paths = [pathsJson]
      }
    }
    const list = Array.isArray(paths) ? paths : [paths]
    const saved = readSavedConfig()
    const next = { ...saved }
    for (const dotted of list) {
      const field = FIELD_BY_PATH.get(String(dotted ?? ''))
      if (field === undefined) {
        throw new RemoteError('unknown_field', `未知的配置项：${dotted}`, {})
      }
      deletePath(next, field.path)
    }
    writeSavedConfig(next)
    await this.onConfigChanged?.()
    return this.list()
  }

}

/** Remove `a.b` from an object, pruning a parent left empty by the removal. */
function deletePath(object, dotted) {
  const parts = dotted.split('.')
  const chain = [object]
  let cursor = object
  for (const part of parts.slice(0, -1)) {
    if (cursor === null || typeof cursor !== 'object') return
    cursor = cursor[part]
    chain.push(cursor)
  }
  if (cursor === null || typeof cursor !== 'object') return
  delete cursor[parts.at(-1)]
  // Prune now-empty parents. Without this, clearing `asr.model` and `asr.env`
  // leaves `"asr": {}` behind — harmless to the reader (an empty object merges
  // nothing) but it makes the file look like it still carries settings, and a
  // user comparing the form against the file would think a reset did not work.
  for (let index = chain.length - 1; index > 0; index -= 1) {
    const node = chain[index]
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue
    if (Object.keys(node).length === 0) delete chain[index - 1][parts[index - 1]]
  }
}

// A cleared field has to be distinguishable from an absent one inside a single
// batch: both end up with no key, but only the cleared one must DELETE a key
// that already exists in the saved file. The marker travels beside the patch.
const CLEARED = Symbol('cleared')
function markClear(patch, dotted) {
  ;(patch[CLEARED] ??= []).push(dotted)
}
function clearedPaths(patch) {
  return patch[CLEARED] ?? []
}

/** Merge a patch into a target object, one level of nesting deep. */
function applyPatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === CLEARED) continue
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const base = target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key]) ? target[key] : {}
      target[key] = { ...base, ...value }
      continue
    }
    target[key] = value
  }
}

/**
 * Persist the overlay.
 *
 * Written through a temporary file and renamed, so a crash mid-write cannot
 * leave a truncated config.json — which the reader treats as "no settings at
 * all", silently reverting every preference including the sender allowlist.
 */
function writeSavedConfig(config) {
  const file = configFile()
  const dir = path.dirname(file)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // the temporary file is best-effort cleanup
    }
    throw new RemoteError('write_failed', `无法写入 ${file}：${error?.message ?? error}`, {})
  }
}

remoteMethods(ConfigController, ['list', 'save', 'reset'])

