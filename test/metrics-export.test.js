import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { exportMetricsSnapshot } from '../src/metrics.js'

test('metrics export reports a failed cycle and writes both files after recovery', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-metrics-export-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  // A regular file cannot be used as a state directory, so both atomic writes
  // fail through the same path a real EACCES/ENOSPC failure takes.
  const blockedState = path.join(root, 'blocked')
  await fs.writeFile(blockedState, 'fixture')
  const warnings = []
  const failed = await exportMetricsSnapshot(blockedState, { counters: { requests: 1 } }, {
    warn: (line) => warnings.push(line),
  })

  assert.deepEqual(failed, { ok: false, failed: ['metrics.json', 'metrics.prom'] })
  assert.deepEqual(warnings, ['metrics snapshot failed: metrics.json, metrics.prom'])

  const recoveredState = path.join(root, 'state')
  const recovered = await exportMetricsSnapshot(recoveredState, { counters: { requests: 2 } }, {
    warn: (line) => warnings.push(line),
  })

  assert.deepEqual(recovered, { ok: true, failed: [] })
  assert.equal(warnings.length, 1)
  const json = JSON.parse(await fs.readFile(path.join(recoveredState, 'metrics.json'), 'utf8'))
  assert.equal(json.counters.requests, 2)
  assert.match(await fs.readFile(path.join(recoveredState, 'metrics.prom'), 'utf8'), /dsh_weixin_requests 2/)
})

test('metrics export names a partially failed file', async () => {
  const warnings = []
  const result = await exportMetricsSnapshot('fixture-state', {}, {
    warn: (line) => warnings.push(line),
    write: async () => ({ json: true, prom: false }),
  })

  assert.deepEqual(result, { ok: false, failed: ['metrics.prom'] })
  assert.deepEqual(warnings, ['metrics snapshot partially failed: metrics.prom'])
})

test('unexpected metrics failures do not echo exception text', async () => {
  const syntheticSecret = ['fixture', 'credential', 'value'].join('-')
  const warnings = []
  const result = await exportMetricsSnapshot('fixture-state', {}, {
    warn: (line) => warnings.push(line),
    write: async () => {
      const error = new Error(`token=${syntheticSecret}`)
      error.code = syntheticSecret
      throw error
    },
  })

  assert.deepEqual(result, { ok: false, failed: ['metrics.json', 'metrics.prom'] })
  assert.deepEqual(warnings, ['metrics snapshot failed unexpectedly'])
  assert.equal(JSON.stringify(warnings).includes(syntheticSecret), false)
})
