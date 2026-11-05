#!/usr/bin/env node
// Vendor drift check (E32).
//
// vendor/openclaw-weixin is a copy of the published @tencent-weixin/openclaw-weixin
// package. Nothing stopped a hand edit from sneaking in, and nothing noticed when
// the vendored copy no longer matched what the tarball said it was — which makes
// "we patched one call site" impossible to audit later.
//
// `--write` records the current hashes; the default mode compares and prints
// every file that appeared, vanished or changed. It is deliberately a plain file
// so a reviewer sees the diff.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashVendorFile } from './lib/vendor-hash.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = path.join(ROOT, 'vendor', 'openclaw-weixin')
const MANIFEST = path.join(ROOT, 'vendor', 'openclaw-weixin.manifest.json')

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

export function collect(vendorDir = VENDOR) {
  if (fs.existsSync(vendorDir) !== true) return {}
  const files = {}
  for (const file of walk(vendorDir).sort()) {
    files[path.relative(vendorDir, file).split(path.sep).join('/')] = hashVendorFile(file)
  }
  return files
}

export function diff(current, recorded) {
  const changed = []
  const added = []
  const removed = []
  for (const [name, digest] of Object.entries(current)) {
    if (recorded[name] === undefined) added.push(name)
    else if (recorded[name] !== digest) changed.push(name)
  }
  for (const name of Object.keys(recorded)) {
    if (current[name] === undefined) removed.push(name)
  }
  return { changed, added, removed }
}

export function readManifest(manifestPath = MANIFEST) {
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { return undefined }
}

export function checkVendor(vendorDir = VENDOR, manifestPath = MANIFEST) {
  const current = collect(vendorDir)
  const count = Object.keys(current).length
  const manifest = readManifest(manifestPath)
  if (manifest === undefined) return { count, current, manifest }
  return { count, current, manifest, ...diff(current, manifest.files) }
}

export function run({
  argv = process.argv.slice(2),
  vendorDir = VENDOR,
  manifestPath = MANIFEST,
  stdout = process.stdout,
} = {}) {
  if (argv.includes('--write')) {
    const current = collect(vendorDir)
    const count = Object.keys(current).length
    const pkg = JSON.parse(fs.readFileSync(path.join(vendorDir, 'package.json'), 'utf8'))
    fs.writeFileSync(manifestPath, `${JSON.stringify({ name: pkg.name, version: pkg.version, files: current }, null, 2)}\n`, 'utf8')
    stdout.write(`recorded ${count} files from ${pkg.name}@${pkg.version}\n`)
    return 0
  }

  const result = checkVendor(vendorDir, manifestPath)
  if (result.manifest === undefined) {
    stdout.write('no manifest yet — run `node bin/vendor-manifest.mjs --write`\n')
    return 1
  }

  const { changed, added, removed, count, manifest } = result
  if (changed.length + added.length + removed.length === 0) {
    stdout.write(`✓ vendor/ matches the manifest (${count} files, ${manifest.name}@${manifest.version})\n`)
    return 0
  }

  for (const name of changed) stdout.write(`~ ${name}\n`)
  for (const name of added) stdout.write(`+ ${name}\n`)
  for (const name of removed) stdout.write(`- ${name}\n`)
  stdout.write(`\nvendor/ drifted from ${manifest.name}@${manifest.version}. Either re-vendor and re-record, or document the patch in docs/progress.md.\n`)
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = run()
}
