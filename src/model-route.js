/** Model routing for interactive conversations and scheduled background work. */

/**
 * Resolve a complete provider/model pair, or leave selection to the host.
 * @param {'chat' | 'side'} purpose
 * @param {Record<string, unknown>} config
 * @returns {{ provider: string, model: string } | undefined}
 */
export function routeFor(purpose, config) {
    const pairs = {
        side: ['sideProvider', 'sideModel'],
        chat: ['chatProvider', 'chatModel'],
    }
    const keys = pairs[purpose]
    if (keys === undefined) return undefined
    const provider = String(config?.[keys[0]] ?? '').trim()
    const model = String(config?.[keys[1]] ?? '').trim()
    return provider !== '' && model !== '' ? { provider, model } : undefined
}

/** Background work uses its explicit route or the host's session default. */
export function sideRouteFor(config) {
    return routeFor('side', config)
}
