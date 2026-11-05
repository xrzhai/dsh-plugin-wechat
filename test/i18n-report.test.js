import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { report, baselineProblems } from '../bin/i18n-report.mjs'
import { CATALOG, translate } from '../src/i18n.js'

test('i18n baseline rejects added lines per file and does not count translated catalogue', t => {
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
  fs.copyFileSync(new URL('../bin/i18n-report.mjs', import.meta.url), path.join(root, 'bin', 'i18n-report.mjs'))
  for (const [args, status] of [[['--fail-over=2'], 0], [['--fail-over', '1'], 1], [['--fail-over=bad'], 1], [['--fail-over'], 1]]) {
    const result = spawnSync(process.execPath, [path.join(root, 'bin', 'i18n-report.mjs'), ...args], { encoding: 'utf8' })
    assert.equal(result.status, status, result.stderr)
  }
  fs.writeFileSync(path.join(root, 'baseline.json'), JSON.stringify(baseline))
  const failed = spawnSync(process.execPath, [path.join(root, 'bin', 'i18n-report.mjs'), '--baseline', path.join(root, 'baseline.json')])
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
