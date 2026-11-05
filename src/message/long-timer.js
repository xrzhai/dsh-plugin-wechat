/**
 * Schedule a callback for an absolute time using Node timers without crossing
 * Node's signed-32-bit timer limit. Longer waits are split into safe segments
 * and re-evaluated against the wall clock after each segment.
 */

/** Largest delay accepted by Node's setTimeout without clamping it to 1 ms. */
export const MAX_TIMEOUT_DELAY_MS = 2 ** 31 - 1

/**
 * @param {object} options
 * @param {number} options.dueAt absolute epoch milliseconds
 * @param {() => void} options.callback runs once when `dueAt` is reached
 * @param {() => number} [options.nowRef]
 * @param {(ms: number, callback: () => void) => unknown} [options.setTimeoutRef]
 * @param {(timer: unknown) => void} [options.clearTimeoutRef]
 * @returns {{ cancel: () => void }}
 */
export function armLongTimer({
  dueAt,
  callback,
  nowRef = () => Date.now(),
  setTimeoutRef = ((ms, cb) => setTimeout(cb, ms)),
  clearTimeoutRef = ((timer) => clearTimeout(timer)),
}) {
  let active = true
  let revision = 0
  let timer

  const arm = () => {
    if (!active) return
    const token = ++revision
    const remaining = Math.max(0, dueAt - nowRef())
    const handle = setTimeoutRef(Math.min(remaining, MAX_TIMEOUT_DELAY_MS), () => {
      // A timer implementation may deliver a stale handle after clearTimeout or
      // duplicate a callback. Only the newest segment may advance the chain.
      if (!active || token !== revision) return
      timer = undefined
      if (nowRef() < dueAt) {
        arm()
        return
      }
      revision += 1
      active = false
      callback()
    })
    if (token === revision) timer = handle
  }

  arm()

  return {
    cancel() {
      if (!active) return
      active = false
      revision += 1
      if (timer === undefined) return
      const handle = timer
      timer = undefined
      clearTimeoutRef(handle)
    },
  }
}
