// Shared request plumbing: auth headers, signal/timeout resolution, a JSON GET helper, and a bounded error-body reader. EveryAPI is reachable with plain `fetch` from every surface that consumes this package (VS Code on Node, Obsidian in Electron/mobile, the MCP server on Node), so there is no SDK and no platform-specific HTTP layer.

export interface RequestOptions {
  /** OpenAI-compatible base, normalized (no trailing slash). */
  baseUrl: string
  apiKey: string
  /** Sent as `X-Client-App`; allowed in browser fetch and Node alike. */
  clientApp?: string
  /** Sent as `User-Agent`. This is a forbidden header in browser/Electron fetch (silently dropped), so only desktop/Node callers (VS Code) set it; browser callers (Obsidian) identify themselves via {@link clientApp}. */
  userAgent?: string
  /** Caller-owned abort signal; takes precedence over {@link timeoutMs}. */
  signal?: AbortSignal
  /** When no {@link signal} is given, abort the request after this many ms. */
  timeoutMs?: number
}

/** Alias kept for call sites that think of the connection as a config. */
export type GatewayConfig = RequestOptions

export function authHeaders(opts: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
  }
  if (opts.clientApp) headers['X-Client-App'] = opts.clientApp
  if (opts.userAgent) headers['User-Agent'] = opts.userAgent
  return headers
}

export function resolveSignal(opts: RequestOptions): AbortSignal | undefined {
  if (opts.signal) return opts.signal
  if (opts.timeoutMs) return AbortSignal.timeout(opts.timeoutMs)
  return undefined
}

/** GET a JSON endpoint with auth, throwing a descriptive error on non-2xx. */
export async function getJson<T>(url: string, opts: RequestOptions): Promise<T> {
  const res = await fetch(url, {
    headers: authHeaders(opts),
    signal: resolveSignal(opts) ?? null,
  })
  if (!res.ok) {
    // Bounded read, same as every other error path in this package (chat.ts, embeddings.ts) — a self-hosted deployment behind a misconfigured proxy can return a multi-MB HTML error page on a 5xx, and this helper backs high-frequency background callers (a VS Code status-bar balance poll, the MCP server's periodic reads) that shouldn't buffer all of it just to keep the first 200 characters.
    const detail = res.body ? redactSecrets(await safeReadText(res.body), opts.apiKey) : ''
    throw new Error(
      `HTTP ${res.status} ${res.statusText} from ${url}${detail ? ` — ${detail.slice(0, 200)}` : ''}`
    )
  }
  return (await res.json()) as T
}

/** Strip credentials out of arbitrary text before it crosses a trust boundary (a thrown error message, which the MCP server forwards verbatim as a tool result). Upstream error bodies are attacker- or misconfiguration-controlled — e.g. a proxy that echoes request headers on a 401 — so any credential reflected in one must not survive into a log line or an LLM-visible tool result. Redacts both this package's `sk-everyapi-…` token shape AND the caller's literal key when supplied: self-hosted gateways (EVERYAPI_BASE_URL) commonly issue `sk-<random>` / `ev-…` keys with no `everyapi-` infix, which the format regex alone would miss. */
export function redactSecrets(text: string, apiKey?: string): string {
  let out = text.replace(/sk-everyapi-[A-Za-z0-9_-]+/g, '[REDACTED]')
  // Guard on a minimum length so a pathologically short/empty key can't blank out unrelated substrings of the message.
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join('[REDACTED]')
  return out
}

/** Read up to ~1 kB of an error body for diagnostics, never throwing. */
export async function safeReadText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  try {
    const decoder = new TextDecoder()
    let out = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
      if (out.length > 1024) break
    }
    return out
  } catch {
    return ''
  } finally {
    // Reached either because the stream ended (`done`) or because the 1 kB cap cut the read short — in the latter case the body is only partially consumed. Cancel it so the connection is torn down instead of left dangling; harmless to call once the stream has already closed.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
