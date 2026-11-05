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
        ? `已找到 ${accountCount} 个带凭据文件的账号。`
        : '还没有可用的账号凭据。请在 DSH 中扫码绑定；只有账号登记记录不算已登录。',
      detailEn: accountCount > 0
        ? `${accountCount} account(s) have credential files.`
        : 'No usable account credential yet. Scan the QR code in DSH; a registry entry alone does not count as signed in.',
      why: '没有有效凭据，微信消息不会进入当前 DSH。',
      whyEn: 'Without a usable credential, messages cannot reach this DSH instance.',
    },
    {
      id: 'allowlist',
      title: '确认谁可以下发工程任务',
      titleEn: 'Authorize who can send engineering tasks',
      required: true,
      state: allowlisted ? 'done' : accountCount > 0 ? 'todo' : 'blocked',
      action: allowlisted ? null : 'allowlist',
      detail: allowlisted
        ? globalSenders.length > 0
          ? `全局白名单有 ${globalSenders.length} 个发送者。`
          : '账号级白名单已包含首位联系人自动登记。'
        : accountCount > 0
          ? '还没有白名单。由账号主人发送第一条消息后，插件会登记该账号的首位联系人；随后请在设置中核对名单。'
          : '先完成账号绑定，再配置或核对白名单。',
      detailEn: allowlisted
        ? globalSenders.length > 0
          ? `The global allowlist has ${globalSenders.length} sender(s).`
          : 'An account-level allowlist includes the automatically enrolled first contact.'
        : accountCount > 0
          ? 'No allowlist yet. The account owner should send the first message so it is enrolled; then review the account-level list in settings.'
          : 'Bind an account first, then configure or review the allowlist.',
      why: '微信端能驱动本机 DSH 读写文件、运行命令；白名单是任务下发边界。',
      whyEn: 'WeChat can drive DSH to read files and run commands on this machine; the allowlist is the task boundary.',
    },
    {
      id: 'workspace',
      title: '确认工作目录',
      titleEn: 'Confirm the working directory',
      required: false,
      state: workspaceVerified ? 'done' : 'note',
      action: workspaceVerified ? null : 'options',
      detail: workspaceVerified
        ? `工作目录可用：${workingDirectory}`
        : workingDirectory !== ''
          ? `已配置 ${workingDirectory}，但首次清单未能确认它是可用目录；请在网关配置中核对。`
          : '请在“网关配置”中选择明确的工作目录。Agent 的读写和命令会以这里为上下文。',
      detailEn: workspaceVerified
        ? `Working directory is usable: ${workingDirectory}`
        : workingDirectory !== ''
          ? `${workingDirectory} is configured, but the checklist could not confirm it is usable; review it in gateway settings.`
          : 'Choose an explicit working directory in gateway settings. File access and commands use it as their project context.',
      why: '微信任务会落在工作目录里；目录不明确时，改错项目或找不到文件都很难排查。',
      whyEn: 'WeChat tasks run in this directory; an unclear workspace makes edits and missing files hard to diagnose.',
    },
    {
      id: 'verify',
      title: '完成一次真实收发验证',
      titleEn: 'Verify one real message round trip',
      required: false,
      state: 'note',
      action: null,
      detail: '请从手机微信发送 `/status`，再发一个简单问题确认收到回复。',
      detailEn: 'Send `/status` from WeChat on your phone, then ask a simple question to confirm the reply arrives.',
      why: '用于确认 DSH 与手机微信双向收发链路正常。',
      whyEn: 'Confirms end-to-end message delivery between DSH and WeChat.',
    },
    {
      id: 'host',
      title: '核对宿主兼容性',
      titleEn: 'Check host compatibility',
      required: false,
      state: hostVerified ? 'done' : 'note',
      action: null,
      detail: hostVerified
        ? `宿主 ${hostVersion} 已在测试列表中。`
        : hostKnown
          ? `检测到宿主 ${hostVersion}（未在已测版本列表中）；若运行异常请执行 npm run doctor。`
          : '未检测到明确的宿主版本；若运行异常请执行 npm run doctor。',
      detailEn: hostVerified
        ? `Host ${hostVersion} is on the tested list.`
        : hostKnown
          ? `Host ${hostVersion} is not on the tested list; run npm run doctor if you encounter issues.`
          : 'Host version not detected; run npm run doctor if you encounter issues.',
      why: '插件运行在 DSH 宿主进程里；版本未知或未测时，应保留真实诊断信息而不是提前判定可用。',
      whyEn: 'The plugin runs inside the DSH host. An unknown or untested version must stay unverified instead of being reported as working.',
    },
    {
      id: 'backup',
      title: '配置状态备份（建议）',
      titleEn: 'Configure state backups (recommended)',
      required: false,
      state: input.backupEnabled === true ? 'done' : 'note',
      action: 'options',
      detail: input.backupEnabled === true
        ? '自动备份已开启。'
        : '状态目录包含会话与控制数据；建议开启自动备份，并用 npm run doctor 检查最近备份。',
      detailEn: input.backupEnabled === true
        ? 'Automatic backups are enabled.'
        : 'The state directory contains sessions and control data. Enable automatic backups and use npm run doctor to check backup freshness.',
      why: '备份是恢复控制面和历史状态的实际保障，不依赖是否使用人设或其他可选功能。',
      whyEn: 'Backups are a practical safeguard for the control channel and its state, independent of optional product features.',
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
 * @param {{ loginHint?: string }} [options]
 */
export function quickstartLines(options = {}) {
  const login = typeof options.loginHint === 'string' && options.loginHint !== '' ? options.loginHint : 'node bin/login.js'
  return [
    { command: 'pnpm install && node bin/install.mjs --profile desktop', note: '从当前仓库安装，并把 desktop profile 链接到这份源码。' },
    { command: login, note: '在 DSH 中完成扫码绑定；首条消息会触发首位联系人自动登记。' },
    { command: 'node bin/onboard.mjs', note: '核对绑定、授权、工作目录和宿主诊断；最后用手机完成一次真实收发。' },
  ]
}
