#!/usr/bin/env node
// Onboard: 新装之后的「照做就行」清单。
//
// 为什么要有这个脚本：`doctor.mjs` 回答的是「哪里坏了」，而新用户问的是
// 「我现在该做什么」。两者不能共用一套输出——前者按「最可能出错的东西」排序，
// 后者必须按「先做什么」排序，而且没做的不该显示成红的。
//
// 这个脚本**只读**：它不改配置、不写状态、不登录，也不创建知识库等可选功能目录。
//
// 退出码：0 表示绑定与授权两项必要配置完成，1 表示本地前置条件还缺；真实收发
// 仍需要用户在手机上验证，不能由这个退出码代替。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { detectHostVersion, hostStatus } from '../src/host-compat.js'
import { buildOnboardingChecklist, describeNextStep, quickstartLines } from '../src/onboarding.js'
import { allowlistForAccount } from '../src/account-registry.js'
import { accountsDir, readSavedConfig } from '../src/state.js'

/** 与插件、doctor 用同一套数据目录约定。 */
function stateRoot() {
  const env = process.env.DSH_WEIXIN_STATE_DIR
  if (typeof env === 'string' && env !== '') return env
  return path.join(os.homedir(), '.dsh', 'weixin')
}

function readConfig() {
  try {
    return readSavedConfig() ?? {}
  } catch {
    return {}
  }
}

function credentialAccountIds() {
  try {
    return fs.readdirSync(accountsDir())
      .filter((name) => name.endsWith('.json') && name.endsWith('.sync.json') === false)
      .flatMap((name) => {
        const accountId = name.slice(0, -'.json'.length)
        // Account ids are filenames; never let a malformed registry entry turn
        // into a path traversal when looking for the credential file.
        if (accountId === '' || path.basename(accountId) !== accountId) return []
        try {
          const credential = JSON.parse(fs.readFileSync(path.join(accountsDir(), name), 'utf8'))
          return typeof credential.token === 'string' && credential.token !== '' ? [accountId] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function accounts(accountIds, config) {
  // The credential files decide whether an account is signed in. The registry is
  // only metadata used to resolve an account-level allowlist; a registry-only
  // record must never be reported as a logged-in account.
  return accountIds.map((accountId) => ({
    accountId,
    allowedSenders: allowlistForAccount(accountId, config).allowedSenders,
  }))
}

function directoryExists(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    return fs.statSync(value).isDirectory()
  } catch {
    return false
  }
}

/**
 * `| head` 会让管道提前关闭。一个状态脚本不应该因为读者先走而抛 EPIPE。
 */
function guardStdout() {
  process.stdout.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(process.exitCode ?? 0)
    throw error
  })
}

function main() {
  guardStdout()
  const root = stateRoot()
  const config = readConfig()
  const loggedInIds = credentialAccountIds()
  const list = accounts(loggedInIds, config)
  // `DSH_HOST_PLIST` lets a test (and an unusual install) point at the app it
  // actually has; an explicitly empty value means "do not claim a host".
  const plistFromEnv = process.env.DSH_HOST_PLIST
  const hostVersion =
    typeof plistFromEnv === 'string'
      ? detectHostVersion(plistFromEnv === '' ? { plistPath: '/nonexistent/Info.plist' } : { plistPath: plistFromEnv })
      : detectHostVersion()
  const workingDirectory = typeof config.cwd === 'string' ? config.cwd.trim() : ''

  const checklist = buildOnboardingChecklist({
    accounts: list,
    accountCount: loggedInIds.length,
    hostVersion,
    hostTested: hostStatus(hostVersion).status === 'tested',
    allowedSenders: Array.isArray(config.allowedSenders) ? config.allowedSenders : [],
    workingDirectory,
    workingDirectoryExists: directoryExists(workingDirectory),
    backupEnabled: config.backupEnabled === true,
  })

  // On a machine with no DSH installed at all (a bare CI runner, a fresh Linux
  // box), the host step cannot be verified — that is not a reason to refuse to
  // say the rest is ready. The checklist already renders it as a note; this flag
  // only decides whether a spare explanation line is worth printing.
  const hostNote = checklist.steps.find((step) => step.id === 'host')
  const noHostToCheck = hostNote !== undefined && hostNote.state !== 'done'

  const icon = { done: '✓', todo: '□', blocked: '—', note: '·' }
  // 终端里中文占两列：按显示宽度算，否则说明那一列会参差不齐。
  const columns = (text) => [...text].reduce((sum, ch) => sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)
  const width = Math.max(...checklist.steps.map((step) => columns(step.title)))

  process.stdout.write(`微信BOT 上手清单  数据目录：${root}\n\n`)
  for (const step of checklist.steps) {
    // An unverifiable host is a note, not an unfinished task; it must never be
    // rendered as verified merely because no better version could be detected.
    const mark = step.id === 'host' && noHostToCheck ? icon.note : icon[step.state]
    process.stdout.write(`${mark} ${step.title}${' '.repeat(width - columns(step.title))}  ${step.detail}\n`)
    if (step.state === 'todo' || step.state === 'blocked') {
      process.stdout.write(`  ${' '.repeat(width + 2)}  ${step.why}\n`)
    }
  }
  process.stdout.write(`\n${checklist.done}/${checklist.total} 步已就绪。${describeNextStep(checklist)}\n`)

  if (checklist.complete !== true) {
    process.stdout.write('\n最快的三条命令：\n')
    for (const line of quickstartLines()) {
      process.stdout.write(`  $ ${line.command}\n    ${line.note}\n`)
    }
  }

  if (noHostToCheck) {
    process.stdout.write('\n未检测到明确的宿主版本，建议在桌面端验证实际收发。\n')
  }

  // Exit 0 exactly when the required steps are done. The host is a note either
  // way (see src/onboarding.js), so it never holds the exit code hostage.
  process.exitCode = checklist.complete ? 0 : 1
}

main()
