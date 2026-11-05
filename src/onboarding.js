/**
 * First-run checklist for the Weixin-to-DSH engineering control channel.
 *
 * This module is deliberately a pure decision layer: callers gather state and
 * render the result. It does not read credentials, touch the network, or claim
 * that a round trip works merely because local configuration exists.
 *
 * Step states:
 * - `done`: verified from the supplied local facts;
 * - `todo`: a required local setup action remains;
 * - `blocked`: the step depends on an earlier required step;
 * - `note`: a manual check or operational safeguard.
 *
 * @module dsh-weixin/onboarding
 */

import { translate } from './i18n.js'

/** Checklist order: required setup first, then verification and operational notes. */
export const ONBOARDING_STEPS = Object.freeze([
  'account',
  'allowlist',
  'workspace',
  'verify',
  'host',
  'backup',
])

/**
 * @typedef {object} OnboardingInput
 * @property {Array<{ accountId: string, allowedSenders?: string[] }>} [accounts]
 *   Accounts backed by a credential file. Registry-only records must not be
 *   passed here as signed-in accounts.
 * @property {number} [accountCount] Credential-backed account count.
 * @property {string | null} [hostVersion]
 * @property {boolean} [hostTested] True only when the host is on the tested list.
 * @property {string[]} [allowedSenders] Global sender allowlist.
 * @property {string} [workingDirectory] Configured DSH working directory.
 * @property {boolean} [workingDirectoryExists] Whether that directory is usable.
 * @property {boolean} [backupEnabled]
 */

function senderList(value) {
  return Array.isArray(value)
    ? value.filter((sender) => typeof sender === 'string' && sender.trim() !== '')
    : []
}

function displayPath(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Build the first-run checklist from already-collected local facts.
 *
 * @param {OnboardingInput} input
 * @returns {{ steps: Array<object>, done: number, total: number, complete: boolean }}
 */
export function buildOnboardingChecklist(input = {}) {
  const accounts = Array.isArray(input.accounts)
    ? input.accounts.filter((account) => account !== null && typeof account === 'object')
    : []
  const accountCount = Number.isFinite(input.accountCount) ? Math.max(0, input.accountCount) : accounts.length
  const globalSenders = senderList(input.allowedSenders)
  const perAccountSenderCounts = accounts.map((account) => senderList(account.allowedSenders).length)
  const allowlisted = globalSenders.length > 0 || perAccountSenderCounts.some((count) => count > 0)
  const hostVersion = typeof input.hostVersion === 'string' ? input.hostVersion.trim() : ''
  const hostKnown = hostVersion !== ''
  const hostVerified = hostKnown && input.hostTested === true
  const workingDirectory = displayPath(input.workingDirectory)
  const workspaceVerified = workingDirectory !== '' && input.workingDirectoryExists === true

  const steps = [
    {
      id: 'account',
      title: '绑定微信账号',
      titleEn: 'Bind a WeChat account',
      required: true,
      state: accountCount > 0 ? 'done' : 'todo',
      action: accountCount > 0 ? null : 'login',
      detail: accountCount > 0
        ? `已检测到 ${accountCount} 个保存了微信登录信息的账号。`
        : '尚未登录微信。请打开 DSH 左侧边栏「大肥鱼」（或「设置 → 插件 → 大肥鱼」），在「微信账号」里扫码绑定。',
      detailEn: accountCount > 0
        ? `Found ${accountCount} account(s) with saved WeChat sign-in data.`
        : 'Not signed in to WeChat yet. Open WeChat in the DSH sidebar (or Settings → Plugins → WeChat), then scan the QR code under WeChat Account.',
      why: '没有保存微信登录信息，手机消息不会送到这台 DSH。',
      whyEn: 'Without saved WeChat sign-in data, messages from your phone cannot reach this DSH instance.',
    },
    {
      id: 'allowlist',
      title: '选择谁能和助理对话',
      titleEn: 'Choose who may chat with the assistant',
      required: true,
      state: allowlisted ? 'done' : accountCount > 0 ? 'todo' : 'blocked',
      action: allowlisted ? null : 'allowlist',
      detail: allowlisted
        ? globalSenders.length > 0
          ? `全局名单中有 ${globalSenders.length} 位联系人；账号级名单可能覆盖全局名单，请以每个账号的实际设置为准。`
          : '至少一个已登录账号保存了单独的联系人名单；它会覆盖全局名单，请逐账号核对实际允许的人。'
        : accountCount > 0
          ? '还没有检测到联系人名单。请让扫码者尽早发送第一条消息；系统会把该账号实际遇到的首位联系人自动登记，随后请核对名单。这条记录不能证明发送者就是扫码人。'
          : '绑定微信账号后，再选择谁能和助理对话。',
      detailEn: allowlisted
        ? globalSenders.length > 0
          ? `The global list contains ${globalSenders.length} contact(s). Account-level lists may override it, so check the effective list for each account.`
          : 'At least one signed-in account has its own contact list. It overrides the global list, so review the effective list for each account.'
        : accountCount > 0
          ? 'No contact list was detected. Ask the person who signed in to send the first message soon. The account will automatically enrol the first contact it actually receives and you should review the result; this does not prove that the sender is the person who scanned the code.'
          : 'Bind a WeChat account first, then choose who may chat with the assistant.',
      why: '名单里的人可以让助理在这台电脑上读取或修改文件、执行命令；只加入你信任的人。',
      whyEn: 'People in this list can ask the assistant to read or change files and run commands on this computer. Only add people you trust.',
    },
    {
      id: 'workspace',
      title: '确认助理在哪个文件夹工作',
      titleEn: 'Choose the assistant’s working folder',
      required: false,
      state: workspaceVerified ? 'done' : 'note',
      action: workspaceVerified ? null : 'options',
      detail: workspaceVerified
        ? `助理会在这里工作：${workingDirectory}`
        : workingDirectory !== ''
          ? `已填写 ${workingDirectory}，但这次没有确认这个文件夹可以访问；请到「高级 → 网关配置」核对。`
          : '没有填写时，助理会使用插件自带的工作区；如果要处理某个项目，请到「高级 → 网关配置」选择项目文件夹。',
      detailEn: workspaceVerified
        ? `The assistant will work here: ${workingDirectory}`
        : workingDirectory !== ''
          ? `${workingDirectory} is set, but this check could not confirm the folder is accessible; review it under Advanced → Gateway options.`
          : 'With no folder set, the assistant uses the plugin’s own workspace. To work in a project, choose its folder under Advanced → Gateway options.',
      why: '项目文件会在这里读写；选错文件夹时，容易改错项目或找不到文件。',
      whyEn: 'Project files are read and changed here. A wrong folder can mean editing the wrong project or losing track of files.',
    },
    {
      id: 'verify',
      title: '用手机确认能收发消息',
      titleEn: 'Check messaging from your phone',
      required: false,
      state: 'note',
      action: null,
      detail: '请从手机微信发送 `/status`，再随便问一句，确认能收到回复。',
      detailEn: 'Send `/status` from WeChat on your phone, then ask a simple question and check that a reply arrives.',
      why: '这一步要靠真实消息确认，本地配置清单不能代替。',
      whyEn: 'Only a real message can confirm this; the local checklist cannot stand in for it.',
    },
    {
      id: 'host',
      title: '确认当前 DSH 版本',
      titleEn: 'Check the current DSH version',
      required: false,
      state: hostVerified ? 'done' : 'note',
      action: null,
      detail: hostVerified
        ? `当前 DSH ${hostVersion} 在已验证范围内。`
        : hostKnown
          ? `检测到 DSH ${hostVersion}，但还没有验证过。插件可能能用；遇到问题时运行 npm run doctor 收集诊断。`
          : '没有识别到 DSH 版本。遇到问题时运行 npm run doctor 收集诊断。',
      detailEn: hostVerified
        ? `This DSH version (${hostVersion}) has been verified.`
        : hostKnown
          ? `DSH ${hostVersion} was detected but has not been verified. The plugin may still work; if you hit problems, run npm run doctor to collect diagnostics.`
          : 'The DSH version could not be identified. If you hit problems, run npm run doctor to collect diagnostics.',
      why: '只有核对过的版本，清单才会把这一项标为已完成。',
      whyEn: 'This item is marked complete only for versions that have actually been checked.',
    },
    {
      id: 'backup',
      title: '备份账号和聊天数据（建议）',
      titleEn: 'Back up account and chat data (recommended)',
      required: false,
      state: input.backupEnabled === true ? 'done' : 'note',
      action: 'options',
      detail: input.backupEnabled === true
        ? '设置中已开启自动备份。这里只确认开关状态，不代表最近一份备份已经验证；可用 npm run doctor 查看最近备份是否存在及更新时间。'
        : '这份清单还没有确认自动备份已经开启。备份包含登录信息、会话、提醒和设置，不包含媒体、日志和下载的语音模型；请到「高级 → 网关配置」确认开关，并用 npm run doctor 查看最近的完成记录。',
      detailEn: input.backupEnabled === true
        ? 'Automatic backups are enabled in settings. This only confirms the switch, not that the latest backup has been verified. Use npm run doctor to see whether a recent backup exists and when it was made.'
        : 'This checklist has not confirmed that automatic backups are enabled. Backups include sign-in data, conversations, reminders and settings, but not media, logs or downloaded speech models. Confirm the switch under Advanced → Gateway options and use npm run doctor to check recent completed backups.',
      why: '有可用的完成备份时，换机、误删或状态文件损坏后可以尝试恢复；没有完成备份就没有这层保障。备份范围和完整性仍需另外核对。',
      whyEn: 'A completed backup can help recover from a device change, accidental deletion or damaged state file. Without one, that protection is absent. Backup coverage and integrity still need separate checks.',
    },
  ]

  const done = steps.filter((step) => step.state === 'done').length
  return {
    steps,
    done,
    total: steps.length,
    // Only locally verifiable prerequisites determine setup completeness. A real
    // round trip remains a manual note and must never be inferred from this flag.
    complete: steps
      .filter((step) => step.required)
      .every((step) => step.state === 'done'),
  }
}

/** One-line progress text for the sidebar or terminal. */
export function describeOnboardingProgress(checklist, t = (zh) => zh) {
  const todo = checklist.steps.filter((step) => step.state === 'todo').length
  if (todo > 0) return t(`还差 ${todo} 步必要配置`, `${todo} required setup step(s) left`)
  const verify = checklist.steps.find((step) => step.id === 'verify')
  if (verify?.state !== 'done') {
    return t('必要配置已齐，还需实际收发验证', 'Required setup is complete; verify a real message round trip')
  }
  return t('已完成实际收发验证', 'A real message round trip is verified')
}

/** The next actionable setup line, including the manual end-to-end check. */
export function describeNextStep(checklist, t = (zh) => zh) {
  const next = checklist.steps.find((step) => step.state === 'todo')
  if (next !== undefined) return t(`下一步：${next.title}`, `Next: ${next.titleEn}`)
  const verify = checklist.steps.find((step) => step.id === 'verify')
  if (verify?.state !== 'done') return t(`下一步：${verify.title}`, `Next: ${verify.titleEn}`)
  return t('本地清单没有剩余项。', 'No local checklist item remains.')
}

/**
 * Shortest path for a fresh checkout of this repository. Installing this repo is
 * the only installation dependency; no upstream plugin or published copy of
 * this package is required.
 *
 * @param {{ loginHint?: string, locale?: 'zh' | 'en' }} [options]
 */
export function quickstartLines(options = {}) {
  const english = options.locale === 'en'
  const login = typeof options.loginHint === 'string' && options.loginHint !== ''
    ? options.loginHint
    : translate('onboarding.loginPanel', undefined, options.locale)
  return [
    {
      command: 'pnpm install && node bin/install.mjs --profile desktop',
      note: english
        ? 'Install this checkout into the DSH desktop profile.'
        : '从当前仓库安装这份插件，并注册到 DSH 的桌面配置。',
    },
    {
      command: login,
      note: english
        ? 'Sign in to WeChat in DSH, then have the person who scanned the code send the first message soon and review the list. Whichever contact arrives first is enrolled; this does not prove that sender is the person who scanned the code.'
        : '在 DSH 里扫码绑定微信后，请扫码者尽早发送第一条消息，并核对允许名单。系统会登记实际收到的首位联系人；这不能证明发送者就是扫码人。',
    },
    {
      command: 'node bin/onboard.mjs',
      note: english
        ? 'Check sign-in, access, the working folder and the DSH version, then send a real message from your phone.'
        : '再检查微信登录、允许名单、工作文件夹和 DSH 版本；最后用手机实际收发一次。',
    },
  ]
}
