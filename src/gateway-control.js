import { INBOUND_NOT_ACCEPTED } from './message/inbound-pending.js'

/** Live gateway switch. Already admitted turns may finish; queued/new ones may not. */
export function createGatewayControl({ isEnabled, isPaused, isDisposed, transports, startLoop, warn = () => {} }) {
  const stopping = new Map()
  const accountEpochs = new Map()
  let lastEnabled = isEnabled()
  let generation = 0
  const enabled = () => !isDisposed() && isEnabled()
  const accepting = (accountId) => enabled() && !isPaused(accountId)

  // stop() synchronously turns polling off before draining admitted turns. Do
  // not make the settings save wait for a potentially long-running agent turn.
  const stopAccount = (accountId) => {
    // Invalidate even an account still awaiting refreshConfig, not yet mapped.
    accountEpochs.set(accountId, (accountEpochs.get(accountId) ?? 0) + 1)
    const transport = transports.get(accountId)
    if (transport === undefined) return
    transports.delete(accountId)
    let stopped
    try {
      stopped = transport.stop()
    } catch (error) {
      stopped = Promise.reject(error)
    }
    const pending = Promise.resolve(stopped).catch((error) => {
      warn(`transport stop failed for ${accountId}: ${String(error)}`)
    }).finally(() => {
      if (stopping.get(accountId) === pending) stopping.delete(accountId)
    })
    stopping.set(accountId, pending)
  }

  const sync = () => {
    const current = enabled()
    if (current !== lastEnabled) generation += 1
    lastEnabled = current
    if (!current) {
      for (const accountId of transports.keys()) stopAccount(accountId)
      return Promise.resolve()
    }
    return startLoop()
  }

  const checkpoint = (accountId) => {
    const expectedGeneration = generation
    const expectedEpoch = accountEpochs.get(accountId) ?? 0
    return () => accepting(accountId) && generation === expectedGeneration && (accountEpochs.get(accountId) ?? 0) === expectedEpoch
  }

  return {
    enabled,
    accepting,
    generation: () => generation,
    checkpoint,
    whenStopped: (accountId) => stopping.get(accountId) ?? Promise.resolve(),
    stopAccount,
    sync,
    // Executed at dispatch time, not when a message was queued by the poller.
    wrapInbound: (accountId, handler) => {
      const canAccept = checkpoint(accountId)
      const transport = transports.get(accountId)
      return async (message) => {
        if (!canAccept() || transports.get(accountId) !== transport) return INBOUND_NOT_ACCEPTED
        return handler(message)
      }
    },
    drain: async () => { await Promise.all([...stopping.values()]) },
  }
}
