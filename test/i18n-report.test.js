import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { report, baselineProblems, countCjkStrings } from '../bin/i18n-report.mjs'
import { CATALOG, createTranslator, translate } from '../src/i18n.js'
import { buildCommandsHelp } from '../src/sessions.js'

test('i18n baseline rejects added strings per file and does not count translated catalogue', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-i18n-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.mkdirSync(path.join(root, 'bin'))
  fs.writeFileSync(path.join(root, 'src', 'i18n.js'), "export const CATALOG = { zh: '中文', en: 'English' }")
  const source = path.join(root, 'src', 'sample.js')
  fs.writeFileSync(source, "// 注释\nexport const a = '中文'\n")
  const baseline = { version: 1, files: { 'src/sample.js': 1 } }
  assert.equal(report(root).total, 1)
  assert.deepEqual(baselineProblems(report(root), baseline), [])
  assert.deepEqual(baselineProblems({ rows: [], total: 0 }, baseline), ['src/sample.js: lower baseline from 1 to 0'])
  fs.appendFileSync(source, "export const b = '新增文案'\n")
  assert.deepEqual(baselineProblems(report(root), baseline), ['src/sample.js: 2 > 1'])
  const cli = fileURLToPath(new URL('../bin/i18n-report.mjs', import.meta.url))
  for (const [args, status] of [[['--fail-over=999999'], 0], [['--fail-over', '0'], 1], [['--fail-over=bad'], 1], [['--fail-over'], 1]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
    assert.equal(result.status, status, result.stderr)
  }
  fs.writeFileSync(path.join(root, 'baseline.json'), JSON.stringify(baseline))
  const failed = spawnSync(process.execPath, [cli, '--baseline', path.join(root, 'baseline.json')])
  assert.equal(failed.status, 1)
})

test('catalogue entries have both locales and interpolate newly migrated failures', () => {
  for (const entry of Object.values(CATALOG)) {
    assert.ok(typeof entry.zh === 'string' && entry.zh.length > 0)
    assert.ok(typeof entry.en === 'string' && entry.en.length > 0)
  }
  assert.equal(translate('error.processing', { reason: 'offline' }, 'en'), '(Processing failed: offline)')
  assert.equal(translate('error.processing', { reason: 'offline' }, 'unknown'), '（处理失败：offline）')
  assert.match(translate('notice.longRunning', {}, 'en'), /result/)
})

test('live command help includes English /compact and omits retired commands', () => {
  const help = buildCommandsHelp(createTranslator('en').t, { all: true })
  assert.match(help, /^\/compact compact the current topic’s history in DSH immediately$/m)
  assert.match(help, /^\/cancel stop the reply currently being generated; actions already run are not undone, and queued messages will still be processed$/m)
  assert.match(help, /^\/new \[title\] start a new topic/m)
  assert.match(help, /^\/clear remove every topic from this WeChat chat’s topic list/m)
  assert.match(help, /original DSH session history is not deleted/)
  assert.doesNotMatch(help, /\/clear clear this session/)
  const helpZh = buildCommandsHelp(undefined, { all: true })
  assert.match(helpZh, /^\/new \[标题\] 在当前微信聊天里新建话题/m)
  assert.match(helpZh, /^\/list 查看当前微信聊天里的所有话题/m)
  assert.match(helpZh, /^\/use <序号> 切换到当前微信聊天里的第几个话题/m)
  assert.match(helpZh, /^\/clear 从当前微信聊天的话题列表移除所有话题，并新开一个/m)
  assert.match(helpZh, /^\/cancel 停止当前正在生成的回复；已经执行的操作不会撤回，排队中的消息仍会继续处理/m)
  assert.doesNotMatch(helpZh, /正在跑的回合/)
  for (const key of [
    'help.mode', 'help.remember', 'help.forget', 'help.memory', 'help.undo', 'help.import',
    'help.recall', 'help.summary', 'help.bad', 'help.good', 'help.style', 'help.digest',
    'help.more', 'help.remind', 'help.remindlist', 'help.remindcancel', 'help.subscribe',
    'help.subscribelist', 'help.subscribecancel', 'help.config', 'help.export', 'help.diag',
    'help.outbox', 'help.quiet', 'help.snooze', 'help.media', 'help.usage',
    'error.reminderInvalidTime', 'error.reminderStorageReadOnly', 'error.reminderSequenceExhausted',
    'error.reminderWriteFailed', 'error.reminderServiceUnavailable', 'error.reminderChangeUnclear',
    'error.timedMessageServiceUnavailable', 'error.timedMessageWriteFailed', 'error.timedMessageCancelUnclear',
  ]) {
    assert.equal(Object.hasOwn(CATALOG, key), false, `${key} should not remain in the command catalogue`)
  }
})


test('string counting catches templates and same-line additions, excluding only catalog contents', () => {
  assert.equal(countCjkStrings("const a = ['已有', `新增：${1}条`]; // 注释"), 3)
  assert.equal(countCjkStrings("export const CATALOG = { zh: '翻译' }; export const stray = '遗漏';", { catalogue: true }), 1)
  assert.equal(countCjkStrings("// 注释\n/* 多行注释 */\nconst pattern = /中文/"), 0)
})
