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
import { CATALOG } from "./i18n.js";

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
    group: "远程查看与管理 DSH 会话", groupEn: "View and manage DSH sessions",
    fields: [
      { path: "sessionDispatcherEnabled", type: T.boolean, default: false,
        label: CATALOG['config.sessionDispatcherEnabled.label'].zh, labelEn: CATALOG['config.sessionDispatcherEnabled.label'].en,
        hint: CATALOG['config.sessionDispatcherEnabled.hint'].zh,
        hintEn: CATALOG['config.sessionDispatcherEnabled.hint'].en },
      { path: "sessionDispatcherSenders", type: T.stringList, default: [], emptyMeansAll: false,
        label: "可以管理其他会话的人", labelEn: "People who may manage other sessions",
        hint: "每行一个微信用户 ID。此人还必须能通过微信正常和助理对话（账号可能沿用全局名单，也可能使用自己的名单）；同时，跨会话管理仍要求此人出现在下面「允许与助手对话的人」全局名单中。这里留空时，任何人都不能查看或操作其他会话。",
        hintEn: "One WeChat user ID per line. The person must also be allowed to chat with the assistant through WeChat, using either the account's own list or the global list it inherits. Cross-session management additionally requires the person to be in the global “People who may chat with the assistant” list below. If this list is empty, nobody can view or manage other sessions." },
      { path: "sessionDispatcherTargets", type: T.stringList, default: [], emptyMeansAll: false,
        label: "可被操作的 DSH 会话", labelEn: "DSH sessions that may be managed",
        hint: "每行填写一个完整的会话 ID，不支持通配符。这里留空时不能操作任何会话；上面列出的所有人共用这份名单，请只加入信任同一批人的会话。",
        hintEn: "One exact session ID per line; wildcards are not supported. An empty list allows no sessions. Everyone listed above shares this list, so include only sessions you trust those people to access." },
      { path: "protectedSessions", type: T.stringList, default: [],
        label: "跨会话管理中只能查看的 DSH 会话", labelEn: "View-only sessions in cross-session management",
        hint: "每行一个会话 ID。它只限制跨会话管理工具：允许查看，但不能借这项功能发送新任务、补充指令或请求停止。普通微信对话不会因为这里而变成只读。",
        hintEn: "One session ID per line. This only limits the cross-session management tools: the session can be viewed, but those tools cannot add tasks, inject instructions or request cancellation. Ordinary WeChat chat does not become read-only because of this setting." },
      { path: "readOnlyPaths", type: T.stringList, default: [],
        label: "不要通过跨会话管理操作的工作区", labelEn: "Workspaces excluded from cross-session management",
        hint: "每行一个绝对路径，子目录和链接到它的路径也一并排除。它只限制“跨会话管理”功能向这些目录中的会话安排或控制任务，不影响普通微信对话，也不是文件权限或系统沙箱。",
        hintEn: "One absolute path per line; descendants and linked paths are excluded too. This only prevents the cross-session management feature from scheduling or controlling tasks in sessions under these folders. It does not affect ordinary WeChat chat and is not a filesystem sandbox." },
    ],
  },
  {
    group: "基本设置",
    groupEn: "Basics",
    fields: [
      {
        path: "enabled",
        type: T.boolean,
        default: true,
        label: "启用微信连接",
        labelEn: "Enabled",
        hint: "关闭后不再接收新的微信消息；已经开始的回复仍会完成。",
        hintEn: "Turning this off pauses new WeChat messages; tasks already in progress can still finish and reply.",
      },
      {
        path: "cwd",
        type: T.string,
        default: "",
        label: "助理默认在哪个文件夹工作",
        labelEn: "Working directory",
        hint: "微信对话默认在这里读写文件（例如 D:\\Workspace），并会读取该目录下的 AGENTS.md。",
        hintEn: "The agent reads and changes files here (for example, D:\\Workspace) and loads AGENTS.md from this folder.",
      },
      {
        path: "workspaceTitle",
        type: T.string,
        default: "",
        label: CATALOG['config.workspaceTitle.label'].zh,
        labelEn: CATALOG['config.workspaceTitle.label'].en,
        hint: CATALOG['config.workspaceTitle.hint'].zh,
        hintEn: CATALOG['config.workspaceTitle.hint'].en,
      },
      {
        path: "chatProvider",
        type: T.string,
        default: "",
        label: "主对话使用的服务",
        labelEn: "Chat service",
        hint: "日常聊天使用哪个模型服务（例如 magpie）；留空就沿用 DSH 当前的默认设置。",
        hintEn: "The model service for everyday chat (for example, magpie). Leave empty to use the current DSH default.",
      },
      {
        path: "chatModel",
        type: T.string,
        default: "",
        label: "主对话使用的模型",
        labelEn: "Chat model",
        hint: "日常聊天使用哪个模型（例如 auto/gemini-3.8-flash）。",
        hintEn: "The model for everyday chat (for example, auto/gemini-3.8-flash).",
      },
      {
        path: "sideProvider",
        type: T.string,
        default: "",
        label: "后台任务使用的服务",
        labelEn: "Background task service",
        hint: "定时消息、群聊摘要等后台任务使用哪个模型服务。留空时会继续沿用现有的后台模型选择规则，包括旧版按用途指定的服务；如果仍没有匹配，就使用 DSH 默认模型。",
        hintEn: "The model service for scheduled messages, group summaries and other background work. Empty keeps the existing background model-selection rules, including legacy per-purpose services, then falls back to the DSH default model if none match.",
      },
      {
        path: "sideModel",
        type: T.string,
        default: "",
        label: "后台任务使用的模型",
        labelEn: "Background task model",
        hint: "后台任务使用哪个模型；需要和服务一栏一起填写。",
        hintEn: "The model for background work; fill this together with the service above.",
      },
    ],
  },
  {
    group: "消息与回复",
    groupEn: "Messages & replies",
    fields: [
      {
        path: "busyMessageMode",
        type: T.enum,
        default: "steer",
        options: [
          { value: "steer", label: "直接把新消息补进当前任务", labelEn: "Add the new message to the current task" },
          { value: "queue", label: "等当前任务结束后再处理", labelEn: "Wait until the current task finishes" },
        ],
        label: "助理忙时收到新消息",
        labelEn: "When the assistant is busy",
        hint: "「直接补充」不会停止当前任务，只会把新消息送进去，当前结果可能因此改变；「等结束后处理」会等这次回复完成，再处理新消息。想停止当前任务请另发 /cancel。",
        hintEn: "“Add” does not stop the current task; it inserts the new message and may change the result already in progress. “Wait” handles the message after this reply finishes. To stop the running task, send /cancel separately.",
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
        label: "长回复每条最多多少字",
        labelEn: "Max message length",
        hint: "一条回复太长时会按这个长度拆成多条消息。",
        hintEn: "Long replies are split into multiple messages at this length.",
      },
      {
        path: "typingIndicator",
        type: T.boolean,
        default: true,
        label: "显示「正在输入」状态",
        labelEn: "Typing indicator",
        hint: "处理消息期间，在微信顶部显示“正在输入”。",
        hintEn: "Show typing indicator in WeChat while running.",
      },
      {
        path: "autoSendFiles",
        type: T.boolean,
        default: false,
        label: "自动发送新生成的文件",
        labelEn: "Automatically send new files",
        hint: "默认关闭。开启后，只检查工作目录第一层本轮新生成或刚更新的支持文件（如 PDF、Office 文档、图片、CSV、ZIP），最多发送 5 个，不会递归扫描子目录。",
        hintEn: "Off by default. When enabled, only supported files created or updated during the current turn in the top level of the workspace are sent, up to five. Subdirectories are not scanned.",
      },
    ],
  },
  {
    group: "谁可以使用",
    groupEn: "Who may use the assistant",
    fields: [
      {
        path: "allowedSenders",
        type: T.stringList,
        default: [],
        label: "允许与助手对话的人",
        labelEn: "People who may chat with the assistant",
        hint: "这是全局默认名单，账号级名单可以覆盖它。名单里的人可以让助理读取或修改文件、执行命令；只加入你信任的人。留空时，没有单独名单的账号会从空白开始，新绑定账号会登记实际收到的首位联系人并请你核对；首位联系人不一定是扫码人。",
        hintEn: "This is the global default; account-level lists can override it. People in this list can ask the assistant to read or change files and run commands. Only add people you trust. If it is empty, an account without its own list starts empty; a newly bound account enrols the first contact it actually receives and asks you to review it. That first contact is not necessarily the person who scanned the code.",
        emptyMeansAll: false,
      },
      {
        path: "allowedChats",
        type: T.stringList,
        default: [],
        label: "只允许哪些微信会话",
        labelEn: "Allowed WeChat conversations",
        hint: "可选。留空表示允许的人可以在任意私聊中使用；群聊不会仅凭这一项开启回复。填写后，只允许每行列出的会话 ID。",
        hintEn: "Optional. Empty allows approved people in any private chat; group chats are not enabled by this setting alone. Otherwise, list the allowed conversation IDs, one per line.",
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
    throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：${t('请选择“开”或“关”', 'Choose on or off')}`, {})
  }
  if (field.type === T.number) {
    const text = String(raw ?? '').trim()
    if (!text) return undefined // empty means "use the default"
    const value = Number(text)
    if (!Number.isFinite(value)) {
      throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：${t(`请填写数字；收到的是「${text}」`, `Enter a number; received “${text}”`)}`, {})
    }
    if (field.min !== undefined && value < field.min) {
      throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：${t(`请填写不小于 ${field.min} 的数`, `Enter a value of at least ${field.min}`)}`, {})
    }
    if (field.max !== undefined && value > field.max) {
      throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：${t(`请填写不大于 ${field.max} 的数`, `Enter a value no greater than ${field.max}`)}`, {})
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
      throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：${t('请从可选项目中选择', 'Choose one of the available options')}`, {})
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
        throw new RemoteError('bad_value', `${t(field.label, field.labelEn)}：${t(`每行请按“名称=值”的格式填写；收到「${text}」`, `Use one “name=value” entry per line; received “${text}”`)}`, {})
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

