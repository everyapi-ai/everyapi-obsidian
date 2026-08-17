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

/**
 * A non-2xx answer from the gateway — meaning the request ARRIVED and was refused, which is a
 * different event from "nothing answered". Callers that only receive a message string cannot tell
 * those apart, so every UI on top of this package had to lump them together: an authenticated 401
 * was reported to users as a connectivity problem, sending them to check a network that was fine
 * instead of the key that wasn't. The status, the backend's own sentence and the request id are
 * carried as fields so a caller can branch on the difference and say something true.
 *
 * `message` is byte-identical to what this package threw before, and this still extends `Error`,
 * so callers that only log or display it are unaffected.
 */
export class GatewayHttpError extends Error {
  readonly status: number
  /**
   * The backend's own human-readable sentence, with any inline `(request id: …)` lifted out into
   * {@link requestId}. Undefined when the body was not a recognizable JSON error envelope (an HTML
   * proxy page, an empty body, a body truncated past the read cap). The adjacent machine code is
   * carried separately for classification (403 can mean quota or permission) and must never be
   * printed on a product surface.
   */
  readonly apiMessage: string | undefined
  /** Machine-readable gateway error code. Kept for classification only; product surfaces must not print it. */
  readonly apiCode: string | undefined
  /** From the `x-everyapi-request-id` response header, else the id the backend inlines in its message. The one string a user can hand to support. */
  readonly requestId: string | undefined

  constructor(
    message: string,
    status: number,
    parts: {
      apiMessage?: string | undefined
      apiCode?: string | undefined
      requestId?: string | undefined
    } = {}
  ) {
    super(message)
    this.name = 'GatewayHttpError'
    this.status = status
    this.apiMessage = parts.apiMessage
    this.apiCode = parts.apiCode
    this.requestId = parts.requestId
  }
}

const REQUEST_ID_HEADER = 'x-everyapi-request-id'
// The backend appends the id to its own sentence — "Invalid token (request id: req_7a53…)" — so
// lift it out rather than making a UI print the whole thing or drop the id with the parenthetical.
const INLINE_REQUEST_ID = /\s*\(request id:\s*([^)]+)\)\s*$/i

/** Pull the human half out of an EveryAPI error body: `{"error":{"message":…}}`, `{"error":"…"}` and a bare `{"message":…}` all occur. Returns nothing for a body that isn't one of those — an unparseable body must yield NO sentence rather than a guessed one. */
export function parseErrorEnvelope(body: string): {
  apiMessage: string | undefined
  apiCode: string | undefined
  requestId: string | undefined
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { apiMessage: undefined, apiCode: undefined, requestId: undefined }
  }
  if (typeof parsed !== 'object' || parsed === null)
    return { apiMessage: undefined, apiCode: undefined, requestId: undefined }
  const envelope = parsed as { error?: unknown; message?: unknown }
  const errorObject =
    typeof envelope.error === 'object' && envelope.error !== null
      ? (envelope.error as { message?: unknown; everyapi_code?: unknown; code?: unknown })
      : undefined
  const nested = errorObject?.message
  const candidate = [envelope.error, nested, envelope.message].find(
    (v): v is string => typeof v === 'string' && v.trim() !== ''
  )
  const apiCode = [errorObject?.everyapi_code, errorObject?.code].find(
    (v): v is string => typeof v === 'string' && v.trim() !== ''
  )
  if (candidate === undefined)
    return { apiMessage: undefined, apiCode, requestId: undefined }
  const inline = INLINE_REQUEST_ID.exec(candidate)
  const sentence = (inline ? candidate.slice(0, inline.index) : candidate).trim()
  return { apiMessage: sentence || undefined, apiCode, requestId: inline?.[1]?.trim() }
}

/** Everything a failed response can honestly say, read once: the bounded credential-scrubbed body text callers put in the message, plus the parsed human sentence and request id. */
export async function describeErrorResponse(
  res: Response,
  apiKey?: string
): Promise<{
  detail: string
  apiMessage: string | undefined
  apiCode: string | undefined
  requestId: string | undefined
}> {
  // Bounded read, same as every other error path in this package (chat.ts, embeddings.ts) — a self-hosted deployment behind a misconfigured proxy can return a multi-MB HTML error page on a 5xx, and this helper backs high-frequency background callers (a VS Code status-bar balance poll, the MCP server's periodic reads) that shouldn't buffer all of it just to keep the first 200 characters.
  const detail = res.body ? redactSecrets(await safeReadText(res.body), apiKey) : ''
  const parsed = parseErrorEnvelope(detail)
  return {
    detail,
    apiMessage: parsed.apiMessage,
    apiCode: parsed.apiCode,
    requestId: parsed.requestId ?? res.headers.get(REQUEST_ID_HEADER) ?? undefined,
  }
}

/** GET a JSON endpoint with auth, throwing a descriptive error on non-2xx. */
export async function getJson<T>(url: string, opts: RequestOptions): Promise<T> {
  const res = await fetch(url, {
    headers: authHeaders(opts),
    signal: resolveSignal(opts) ?? null,
  })
  if (!res.ok) {
    const { detail, apiMessage, apiCode, requestId } = await describeErrorResponse(
      res,
      opts.apiKey
    )
    throw new GatewayHttpError(
      `HTTP ${res.status} ${res.statusText} from ${url}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      res.status,
      { apiMessage, apiCode, requestId }
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
