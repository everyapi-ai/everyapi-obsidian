// Streaming chat over the OpenAI-compatible `/v1/chat/completions`, with
// hand-rolled SSE parsing (the openai SDK would add ~200 kB to each bundle
// for the two endpoints we use). Supports the union of what the surfaces
// need: text deltas everywhere, tool-call accumulation (VS Code Copilot
// Chat) and a trailing usage block (the Obsidian panel) opt-in via callback.

import { authHeaders, resolveSignal, safeReadText, type RequestOptions } from './http'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
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
   * upstream rather than rejected, so this is always safe.
   */
  modelOptions?: Record<string, unknown>
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
}

export async function streamChat(input: StreamChatInput): Promise<void> {
  const wantUsage = Boolean(input.onUsage)
  const body = {
    model: input.model,
    messages: input.messages,
    stream: true,
    ...(wantUsage ? { stream_options: { include_usage: true } } : {}),
    ...(input.modelOptions ?? {}),
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
    if (chunk.usage && input.onUsage) {
      input.onUsage(chunk.usage)
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
    model: input.model,
    messages: input.messages,
    stream: false,
    ...(input.modelOptions ?? {}),
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
  }
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    usage: json.usage ?? undefined,
  }
}
