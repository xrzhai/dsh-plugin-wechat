// Node fetch can reach its own connection/response deadline before ours.
const fetchTimeoutCodes = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
export function isRequestTimeout(error) {
    return error?.name === "TimeoutError" || fetchTimeoutCodes.has(error?.cause?.code) || fetchTimeoutCodes.has(error?.code);
}

/** Bound the wait even if the underlying fetch or body reader ignores abort. */
export async function withRequestDeadline({ label, timeoutMs, abortSignal }, request) {
    if (timeoutMs === undefined && !abortSignal)
        return request(undefined);

    const controller = new AbortController();
    const onStop = () => controller.abort();
    if (abortSignal?.aborted)
        onStop();
    controller.signal.throwIfAborted();
    abortSignal?.addEventListener("abort", onStop, { once: true });
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        controller.abort(new DOMException(`${label}: request timed out after ${timeoutMs}ms`, "TimeoutError"));
    }, timeoutMs);
    const { signal } = controller;
    let onAbort;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        return await Promise.race([aborted, request(signal)]);
    }
    finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        abortSignal?.removeEventListener("abort", onStop);
    }
}
