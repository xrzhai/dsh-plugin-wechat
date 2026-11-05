import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { canonicalizeVendorBytes, hashVendorBytes, isBinary } from '../bin/lib/vendor-hash.mjs'
import { checkVendor, run } from '../bin/vendor-manifest.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-manifest-'))
  const vendorDir = path.join(root, 'vendor')
  const manifestPath = path.join(root, 'manifest.json')
  fs.mkdirSync(vendorDir)
  fs.writeFileSync(path.join(vendorDir, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n')
  fs.writeFileSync(path.join(vendorDir, 'index.js'), 'export const value = 1\n')
  const files = {
    'index.js': hashVendorBytes(fs.readFileSync(path.join(vendorDir, 'index.js'))),
    'package.json': hashVendorBytes(fs.readFileSync(path.join(vendorDir, 'package.json'))),
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ name: 'fixture', version: '1.0.0', files }))
  return { root, vendorDir, manifestPath }
}

test('text hashes ignore platform CRLF differences', () => {
  const lf = Buffer.from('first\nsecond\n')
  const crlf = Buffer.from('first\r\nsecond\r\n')

  assert.equal(isBinary(lf), false)
  assert.equal(hashVendorBytes(lf), hashVendorBytes(crlf))
  assert.equal(canonicalizeVendorBytes(crlf).toString(), lf.toString())
})

test('binary hashes preserve raw line-ending bytes', () => {
  const binary = Buffer.from([0x0d, 0x0a, 0xff])

  assert.equal(isBinary(binary), true)
  assert.equal(canonicalizeVendorBytes(binary), binary)
  assert.equal(hashVendorBytes(binary), createHash('sha256').update(binary).digest('hex'))
})

test('a CRLF checkout matches an LF manifest without rewriting it', () => {
  const { root, vendorDir, manifestPath } = fixture()
  try {
    fs.writeFileSync(path.join(vendorDir, 'index.js'), 'export const value = 1\r\n')
    const before = fs.readFileSync(manifestPath)
    const chunks = []
    const status = run({ vendorDir, manifestPath, argv: [], stdout: { write: (chunk) => chunks.push(String(chunk)) } })

    assert.equal(status, 0)
    assert.match(chunks.join(''), /matches the manifest/)
    assert.deepEqual(fs.readFileSync(manifestPath), before)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a real text change still fails verification', () => {
  const { root, vendorDir, manifestPath } = fixture()
  try {
    fs.writeFileSync(path.join(vendorDir, 'index.js'), 'export const value = 2\r\n')
    const result = checkVendor(vendorDir, manifestPath)

    assert.deepEqual(result.changed, ['index.js'])
    assert.equal(run({ vendorDir, manifestPath, argv: [], stdout: { write: () => {} } }), 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
