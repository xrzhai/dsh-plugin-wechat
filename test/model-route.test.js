import assert from 'node:assert/strict'
import test from 'node:test'
import { routeFor, sideRouteFor } from '../src/model-route.js'

test('chat and scheduled work use only their complete explicit route', () => {
  const config = { chatProvider: ' primary ', chatModel: 'chat', sideProvider: 'cheap', sideModel: 'scheduled' }
  assert.deepEqual(routeFor('chat', config), { provider: 'primary', model: 'chat' })
  assert.deepEqual(sideRouteFor(config), { provider: 'cheap', model: 'scheduled' })
  assert.equal(sideRouteFor({ sideProvider: 'cheap' }), undefined)
  assert.equal(sideRouteFor({ sideModel: 'scheduled' }), undefined)
})

test('retired background-purpose settings never select a model', () => {
  const config = {
    memoryProvider: 'old', memoryModel: 'memory',
    proactiveProvider: 'old', proactiveModel: 'proactive',
    reportProvider: 'old', reportModel: 'report',
  }
  assert.equal(sideRouteFor(config), undefined)
  for (const purpose of ['memory', 'proactive', 'report']) {
    assert.equal(routeFor(purpose, config), undefined)
  }
})
