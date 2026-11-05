#!/usr/bin/env node
// Fast checks that do not need the suite: every source file parses, and the
// packaging rules the release script cares about hold. This is what CI runs
// before npm test, and what a pre-commit hook should run.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { unusedImports } from './lib/unused-imports.mjs'
import { report, baselineProblems } from './i18n-report.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      out.push(...walk(full))
    } else if (/\.(?:js|mjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'bin')), ...walk(path.join(ROOT, 'test'))]
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    problems.push(`${path.relative(ROOT, file)}: ${String(error.stderr ?? error).split('\n')[0]}`)
  }
}

for (const file of files.filter(file => !file.startsWith(path.join(ROOT, 'test') + path.sep))) {
  try {
    for (const item of unusedImports(fs.readFileSync(file, 'utf8'))) {
      problems.push(`${path.relative(ROOT, file)}:${item.line}: unused import ${item.name}`)
    }
  } catch (error) { problems.push(`${path.relative(ROOT, file)}: ${error.message}`) }
}
try {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'bin', 'i18n-baseline.json'), 'utf8'))
  problems.push(...baselineProblems(report(ROOT), baseline).map(line => 'i18n baseline: ' + line))
} catch (error) { problems.push('i18n baseline: ' + error.message) }

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const filesField = Array.isArray(pkg.files) ? pkg.files : []
for (const required of ['src', 'bin', 'vendor', 'assets']) {
  if (filesField.includes(required) !== true) problems.push(`package.json files[] is missing ${required}`)
}
if (typeof pkg.dsh?.client === 'undefined') problems.push('package.json is missing dsh.client')

// A provenance claim is valid only when the release workflow requests it.
const releaseWorkflow = path.join(ROOT, '.github', 'workflows', 'release.yml')
if (fs.existsSync(releaseWorkflow)) {
  const text = fs.readFileSync(releaseWorkflow, 'utf8')
  if (!text.includes('npm publish --provenance')) problems.push('.github/workflows/release.yml does not ask for provenance')
  if (!text.includes('id-token: write')) problems.push('.github/workflows/release.yml cannot get an OIDC token (missing id-token: write)')
} else {
  console.log('· no .github/workflows/release.yml — publishes from CI are not wired up')
}
process.stdout.write(`checked ${files.length} files\n`)
if (problems.length > 0) {
  for (const line of problems) process.stdout.write(`✗ ${line}\n`)
  process.exitCode = 1
} else {
  console.log('✓ syntax, packaging, unused imports and i18n baseline checks passed')
}
