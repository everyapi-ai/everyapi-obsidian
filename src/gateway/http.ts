// Shared request plumbing: auth headers, signal/timeout resolution, a JSON
// GET helper, and a bounded error-body reader. EveryAPI is reachable with
// plain `fetch` from every surface that consumes this package (VS Code on
// Node, Obsidian in Electron/mobile, the MCP server on Node), so there is no
// SDK and no platform-specific HTTP layer.

export interface RequestOptions {
  /** OpenAI-compatible base, normalized (no trailing slash). */
  baseUrl: string
  apiKey: string
  /** Sent as `X-Client-App`; allowed in browser fetch and Node alike. */
  clientApp?: string
  /**
   * Sent as `User-Agent`. This is a forbidden header in browser/Electron
   * fetch (silently dropped), so only desktop/Node callers (VS Code) set it;
   * browser callers (Obsidian) identify themselves via {@link clientApp}.
   */
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
    const detail = await res.text().catch(() => '')
    throw new Error(
      `HTTP ${res.status} ${res.statusText} from ${url}${detail ? ` — ${detail.slice(0, 200)}` : ''}`
    )
  }
  return (await res.json()) as T
}

/** Read up to ~1 kB of an error body for diagnostics, never throwing. */
export async function safeReadText(stream: ReadableStream<Uint8Array>): Promise<string> {
  try {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
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
  }
}
