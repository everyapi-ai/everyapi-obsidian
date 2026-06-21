// Streaming chat over the OpenAI-compatible `/v1/chat/completions`, with
// hand-rolled SSE parsing (the openai SDK would add ~200 kB to each bundle
// for the two endpoints we use). Supports the union of what the surfaces
// need: text deltas everywhere, tool-call accumulation (VS Code Copilot
// Chat) and a trailing usage block (the Obsidian panel) opt-in via callback.

import { authHeaders, resolveSignal, safeReadText, type RequestOptions } from './http'

/** A text segment of a multimodal message. */
export interface TextPart {
  type: 'text'
  text: string
}

/** An image segment of a multimodal message: a data: or http(s) URL the gateway
 *  forwards to a vision-capable upstream in OpenAI `image_url` shape. */
export interface ImagePart {
  type: 'image_url'
  image_url: { url: string }
}

/** One part of a multimodal message `content` array. */
export type ContentPart = TextPart | ImagePart

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  /**
   * Plain text, or — for a user turn carrying attached images — an OpenAI
   * multimodal `content` array of text/image parts. The request body forwards it
   * verbatim, so an array reaches a vision model unchanged; a plain string is the
   * unchanged common case.
   */
  content: string | ContentPart[]
  /**
   * OpenAI tool-call protocol. Present only on an `assistant` turn that invoked
   * tools; carried verbatim so a multi-turn tool conversation round-trips. Plain
   * chat never sets it, so existing callers are unaffected.
   */
  tool_calls?: ChatToolCall[]
  /** Links a `tool`-role result message back to its originating call id. */
  tool_call_id?: string
}

/** An assistant's request to call a tool, in OpenAI's wire shape. */
export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** A function tool advertised to the upstream so it can emit tool calls. */
export interface ChatTool {
  type: 'function'
  function: { name: string; description?: string; parameters?: object }
}

export interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface StreamChatInput extends RequestOptions {
  model: string
  messages: ChatMessage[]
  /**
   * Provider-specific tunables (temperature, top_p, stop, …) spread straight
   * into the request body. Keys EveryAPI doesn't understand are ignored
   * upstream rather than rejected, so this is always safe. `model`, `messages`,
   * `stream` and `stream_options` are reserved by this function and cannot be
   * overridden here — the protocol-critical fields always win.
   */
  modelOptions?: Record<string, unknown>
  /**
   * OpenAI function-tool definitions forwarded to the upstream so it can emit
   * tool calls. Omit (or pass empty) for a plain chat request — the `tools` key
   * is then absent from the body, exactly as before.
   */
  tools?: ChatTool[]
  signal: AbortSignal
  onTextDelta: (chunk: string) => void
  /**
   * Fired once per completed tool call at end-of-stream — OpenAI streams the
   * arguments JSON in fragments, so it's only parseable once the last
   * fragment arrives. Omit if the caller doesn't consume tool calls; without
   * it tool-call deltas are ignored entirely.
   */
  onToolCall?: (call: ToolCall) => void
  /**
   * Fired at most once with the trailing usage block. Providing this callback
   * is what opts the request into `stream_options.include_usage`; callers
   * must tolerate it never firing (not every upstream reports usage).
   */
  onUsage?: (usage: ChatUsage) => void
}

interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
  usage?: ChatUsage | null
  // OpenAI-compatible gateways routinely return HTTP 200 and then signal a
  // failure mid-stream as a JSON frame (e.g. context-length exceeded). Surface
  // it instead of dropping the frame, otherwise the stream ends "cleanly" and
  // the caller renders an empty/partial reply as a success.
  error?: { message?: string; type?: string; code?: string } | string
}

export async function streamChat(input: StreamChatInput): Promise<void> {
  const wantUsage = Boolean(input.onUsage)
  const body = {
    ...(input.modelOptions ?? {}),
    model: input.model,
    messages: input.messages,
    stream: true,
    ...(input.tools && input.tools.length ? { tools: input.tools } : {}),
    ...(wantUsage ? { stream_options: { include_usage: true } } : {}),
  }

  const res = await fetch(`${input.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      ...authHeaders(input),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: input.signal,
  })

  if (!res.ok) {
    const detail = res.body ? await safeReadText(res.body) : ''
    throw new Error(
      `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`
    )
  }

  // Tool-call deltas arrive fragmented across chunks (id once, arguments
  // char-by-char). Accumulate by index, flush once the stream ends.
  const toolCallAcc = new Map<number, { id: string; name: string; argsBuf: string }>()
  // Latch the usage block so onUsage fires at most once with the final
  // (last-seen) value — some OpenAI-compatible upstreams emit usage on every
  // delta, not just the trailing chunk, but the callback contract is one-shot.
  let usage: ChatUsage | undefined

  const processLine = (rawLine: string): void => {
    if (rawLine.startsWith(':')) return // SSE comment / keep-alive
    if (!rawLine.startsWith('data:')) return
    // The space after `data:` is optional per the SSE spec but always present
    // in OpenAI's emitter. Strip with a regex so the rare upstream that omits
    // it doesn't shift the JSON payload by one char.
    const payload = rawLine.replace(/^data:\s?/, '').replace(/\s+$/, '')
    if (!payload || payload === '[DONE]') return

    let chunk: OpenAiChunk
    try {
      chunk = JSON.parse(payload) as OpenAiChunk
    } catch {
      return // malformed — likely a partially-flushed keep-alive
    }

    // A mid-stream error frame arrives after a 200, so the HTTP-level guard
    // above never fires. Throw so the streaming loop rejects and the caller
    // hits its error path instead of treating the truncated reply as success.
    if (chunk.error) {
      throw new Error(
        typeof chunk.error === 'string'
          ? chunk.error
          : (chunk.error.message ?? 'upstream stream error')
      )
    }

    const delta = chunk.choices?.[0]?.delta
    const content = delta?.content
    if (typeof content === 'string' && content.length > 0) {
      input.onTextDelta(content)
    }
    if (input.onToolCall && delta?.tool_calls) {
      delta.tool_calls.forEach((tc, idx) => {
        // OpenAI carries the logical tool-call slot in each delta's own
        // `index` field. A chunk's tool_calls array usually holds a single
        // element, so the array position is always 0 — keying by it would
        // collapse parallel/multiple tool calls into one. Fall back to the
        // array position only when upstream omits `index`.
        const i = tc.index ?? idx
        const cur = toolCallAcc.get(i) ?? { id: '', name: '', argsBuf: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) cur.argsBuf += tc.function.arguments
        toolCallAcc.set(i, cur)
      })
    }
    if (chunk.usage) {
      usage = chunk.usage
    }
  }

  // iOS WKWebView (Obsidian mobile) doesn't expose a streaming response body —
  // res.body is null even on a 200. Fall back to buffering and replaying so
  // the reply still arrives (no incremental typing) instead of a misleading
  // "HTTP 200 OK" error.
  if (!res.body) {
    const text = await res.text()
    for (const rawLine of text.split('\n')) processLine(rawLine.replace(/\r$/, ''))
  } else {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let lineEnd: number
      while ((lineEnd = buf.indexOf('\n')) !== -1) {
        const rawLine = buf.slice(0, lineEnd).replace(/\r$/, '')
        buf = buf.slice(lineEnd + 1)
        processLine(rawLine)
      }
    }
    // Some upstreams close the connection after a `data:` line with no
    // trailing newline (`[DONE]` or a final delta). Flush the remainder so we
    // don't silently drop the last token.
    const trailing = buf.replace(/\r$/, '').trim()
    if (trailing) processLine(trailing)
  }

  if (input.onToolCall) {
    for (const tc of toolCallAcc.values()) {
      if (!tc.id || !tc.name) continue
      let parsed: unknown = {}
      try {
        parsed = tc.argsBuf ? JSON.parse(tc.argsBuf) : {}
      } catch {
        // Upstream emitted malformed JSON — pass the raw attempt through so
        // the caller can at least see what was tried.
        parsed = tc.argsBuf
      }
      input.onToolCall({ id: tc.id, name: tc.name, input: parsed })
    }
  }

  if (usage && input.onUsage) {
    input.onUsage(usage)
  }
}

export interface CompleteChatInput extends RequestOptions {
  model: string
  messages: ChatMessage[]
  /** Same passthrough tunables as {@link StreamChatInput.modelOptions}. */
  modelOptions?: Record<string, unknown>
}

export interface ChatResult {
  text: string
  usage?: ChatUsage
}

/**
 * One-shot (non-streaming) chat completion. Used by callers that don't render
 * tokens incrementally — the MCP server returns the whole reply as one tool
 * result. Honors {@link RequestOptions.timeoutMs}/`signal`; a chat call can be
 * slow, so callers should pass a generous timeout rather than the short one
 * used for account GETs.
 */
export async function completeChat(input: CompleteChatInput): Promise<ChatResult> {
  const body = {
    ...(input.modelOptions ?? {}),
    model: input.model,
    messages: input.messages,
    stream: false,
  }

  const res = await fetch(`${input.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      ...authHeaders(input),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: resolveSignal(input) ?? null,
  })

  if (!res.ok) {
    const detail = res.body ? await safeReadText(res.body) : ''
    throw new Error(
      `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`
    )
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: ChatUsage | null
    error?: { message?: string; type?: string; code?: string } | string
  }
  // Some gateways return HTTP 200 with a top-level `error` body instead of a
  // non-2xx status. Surface it rather than handing back an empty reply.
  if (json.error) {
    throw new Error(
      typeof json.error === 'string'
        ? json.error
        : (json.error.message ?? 'upstream error')
    )
  }
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    usage: json.usage ?? undefined,
  }
}
