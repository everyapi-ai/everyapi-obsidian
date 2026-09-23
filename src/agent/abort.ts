// Cancellation primitives shared by the agent loop, the vault executors and the panel. Kept in their own module so the executors can end a long scan without importing the loop (and creating a runtime cycle), and so every layer agrees on what "the user pressed Stop" looks like on the wire.

/** True for the error a fetch, a reader, or one of our own abort checks raises when a signal fires. Matched by `name` rather than by constructor: Electron's renderer, Node and the WKWebView on iOS Obsidian do not all raise the same class, and a DOMException-only test silently misses one of them. */
export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
}

/** Throw the standard AbortError when `signal` has fired. A user stop is a cancellation, not a tool failure and not the iteration budget being exhausted, so the caller's abort path (keep partial output, add no "budget reached" note) is the one that must run. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
}
