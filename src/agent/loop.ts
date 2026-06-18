// The EveryAPI agentic tool-call loop for the Obsidian surface (see
// docs/agent-tools/loop.md). Ported from apps/vscode/src/agent/loop.ts — the
// loop itself is host-agnostic; only the auth header differs (Obsidian runs in
// Electron's fetch, where User-Agent is silently dropped, so we identify the
// surface via X-Client-App instead of userAgent — same as the gateway's
// streamChat).
//
// Drives a multi-turn conversation against the EveryAPI gateway in pure OpenAI
// shape: it sends the `tools` array and `tool_choice: "auto"`, parses the
// assistant's `tool_calls`, runs each through the per-host executors (which
// enforce safety), appends one `role:"tool"` message per call, and repeats
// until the assistant stops calling tools or the iteration cap is hit.
//
// Why a dedicated client instead of @everyapi-ai/gateway's streamChat: that
// shared client's request body and ChatMessage type carry neither a `tools`
// field nor `tool`/assistant-with-tool_calls messages. This module sends the
// richer agentic request shape the loop requires while still talking the same
// /v1 endpoint. Text is streamed for live UI; tool_calls finalize at
// end-of-stream exactly as loop.md's streaming accumulator prescribes.

import { authHeaders } from '@everyapi-ai/gateway'

import { resultToString } from './diff'
import type { VaultExecutors } from './executors'
import { AGENT_TOOLS, isToolName } from './tools'

export const MAX_ITERATIONS = 25
/** Stop letting the model retry the same file after this many consecutive fails. */
const MAX_CONSECUTIVE_TOOL_FAILS = 2

// ---- OpenAI wire types (the subset the loop needs) ----------------------------

interface AssistantToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type LoopMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: AssistantToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface AgentLoopInput {
  baseUrl: string
  apiKey: string
  /** Sent as X-Client-App (User-Agent is forbidden in Electron fetch). */
  clientApp: string
  model: string
  /** System prompt + prior turns + the new user message, in order. */
  messages: LoopMessage[]
  executors: VaultExecutors
  signal: AbortSignal
  /** Live assistant-text delta for the current turn (UI streaming). */
  onTextDelta: (chunk: string) => void
  /** Fired when a new assistant turn begins, so the UI can reset its buffer. */
  onTurnStart?: () => void
  /** Fired when a tool is about to run / has run, for an activity log in the UI. */
  onToolEvent?: (e: ToolEvent) => void
  /** Aggregated usage across all round trips, when the gateway reports it. */
  onUsage?: (usage: ChatUsage) => void
}

export interface ToolEvent {
  name: string
  args: Record<string, unknown>
  status: 'running' | 'ok' | 'error' | 'denied'
}

export interface AgentLoopResult {
  /** The final assistant text to display. */
  text: string
  /** How many model round trips were made. */
  iterations: number
  /** True when the loop stopped at the iteration cap rather than a clean finish. */
  truncated: boolean
}

interface StreamTurn {
  text: string
  toolCalls: AssistantToolCall[]
  finishReason: string | undefined
  usage: ChatUsage | undefined
}

/**
 * Run the agentic loop to completion. Returns the final assistant text. Tool
 * execution is gated inside the executors (approval for mutating tools); a
 * denied/failed tool produces a structured result the model can react to, so
 * the loop never throws on a tool failure — only on a transport/HTTP error.
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const messages = [...input.messages]
  let lastText = ''
  // Track consecutive failures per target (path) to break retry storms.
  const failStreak = new Map<string, number>()

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    input.onTurnStart?.()
    const turn = await streamOneTurn(input, messages)
    lastText = turn.text
    if (turn.usage) input.onUsage?.(turn.usage)

    // Append the assistant turn (with its tool_calls) BEFORE running any tool.
    const assistant: LoopMessage = { role: 'assistant', content: turn.text }
    if (turn.toolCalls.length) assistant.tool_calls = turn.toolCalls
    messages.push(assistant)

    if (turn.toolCalls.length === 0) {
      return { text: turn.text, iterations: iteration, truncated: false }
    }

    // Execute each call sequentially (loop.md: deterministic ordering, and a
    // later mutating call may depend on an earlier one). One tool message per
    // call, preserving tool_call_id.
    for (const call of turn.toolCalls) {
      if (input.signal.aborted) {
        // A user stop between tool calls is a cancellation, not the iteration
        // budget being exhausted. Throw the standard AbortError so the caller's
        // abort handling (which keeps partial output and adds no "budget
        // reached" note) runs, instead of returning a mislabelled truncation.
        throw input.signal.reason instanceof Error
          ? input.signal.reason
          : new DOMException('Aborted', 'AbortError')
      }
      const resultStr = await runOneCall(input, call, failStreak)
      messages.push({ role: 'tool', tool_call_id: call.id, content: resultStr })
    }
  }

  // Iteration cap reached: make one final non-tool request so the model can
  // summarize where it got to, then surface that as the (truncated) answer.
  input.onTurnStart?.()
  const final = await streamOneTurn(
    { ...input, messages },
    [
      ...messages,
      {
        role: 'user',
        content:
          'You have reached the tool-iteration budget for this task. Stop calling tools and give a concise summary of what you did, what remains, and any next steps for the user.',
      },
    ],
    /* disableTools */ true,
  )
  return { text: final.text || lastText, iterations: MAX_ITERATIONS, truncated: true }
}

/** Execute a single tool call and return its result-envelope string. */
async function runOneCall(
  input: AgentLoopInput,
  call: AssistantToolCall,
  failStreak: Map<string, number>,
): Promise<string> {
  const name = call.function.name
  if (!isToolName(name)) {
    return resultToString({
      status: 'error',
      error: `Unknown tool '${name}'.`,
      suggestion: 'Call one of: read_file, list_dir, search_text, write_file, apply_diff.',
    })
  }

  let args: Record<string, unknown>
  try {
    const parsed: unknown = call.function.arguments ? JSON.parse(call.function.arguments) : {}
    args = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return resultToString({
      status: 'error',
      error: 'Could not parse the tool arguments as JSON.',
      suggestion: 'Re-emit this tool call with valid JSON arguments.',
    })
  }

  // Break a retry storm: if the model keeps failing the same target, stop it.
  const targetKey = `${name}:${String(args.path ?? '')}`
  if ((failStreak.get(targetKey) ?? 0) >= MAX_CONSECUTIVE_TOOL_FAILS) {
    return resultToString({
      status: 'error',
      error: `Repeated failures on ${targetKey}; not retrying automatically.`,
      suggestion: 'Re-read the note from scratch or ask the user to clarify before trying this target again.',
    })
  }

  input.onToolEvent?.({ name, args, status: 'running' })
  const result = await input.executors.execute(name, args)
  input.onToolEvent?.({ name, args, status: result.status === 'ok' ? 'ok' : result.status })

  if (result.status === 'error') failStreak.set(targetKey, (failStreak.get(targetKey) ?? 0) + 1)
  else failStreak.delete(targetKey)

  return resultToString(result)
}

// ---- one model round trip (streaming, OpenAI shape) ---------------------------

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: ChatUsage | null
}

async function streamOneTurn(
  input: AgentLoopInput,
  messages: LoopMessage[],
  disableTools = false,
): Promise<StreamTurn> {
  const body = {
    model: input.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(disableTools
      ? { tool_choice: 'none' as const }
      : { tools: AGENT_TOOLS, tool_choice: 'auto' as const }),
  }

  const res = await fetch(`${input.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      ...authHeaders({ baseUrl: input.baseUrl, apiKey: input.apiKey, clientApp: input.clientApp }),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: input.signal,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }

  let text = ''
  let finishReason: string | undefined
  let usage: ChatUsage | undefined
  // Accumulate fragmented tool-call deltas keyed by their `index` slot.
  const acc = new Map<number, { id: string; name: string; argsBuf: string }>()

  const processLine = (rawLine: string): void => {
    if (rawLine.startsWith(':')) return
    if (!rawLine.startsWith('data:')) return
    const payload = rawLine.replace(/^data:\s?/, '').replace(/\s+$/, '')
    if (!payload || payload === '[DONE]') return
    let chunk: OpenAiStreamChunk
    try {
      chunk = JSON.parse(payload) as OpenAiStreamChunk
    } catch {
      return
    }
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (typeof delta?.content === 'string' && delta.content.length) {
      text += delta.content
      input.onTextDelta(delta.content)
    }
    if (delta?.tool_calls) {
      delta.tool_calls.forEach((tc, idx) => {
        const i = tc.index ?? idx
        const cur = acc.get(i) ?? { id: '', name: '', argsBuf: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) cur.argsBuf += tc.function.arguments
        acc.set(i, cur)
      })
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason
    if (chunk.usage) usage = chunk.usage
  }

  if (!res.body) {
    const t = await res.text()
    for (const line of t.split('\n')) processLine(line.replace(/\r$/, ''))
  } else {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        processLine(buf.slice(0, nl).replace(/\r$/, ''))
        buf = buf.slice(nl + 1)
      }
    }
    const trailing = buf.replace(/\r$/, '').trim()
    if (trailing) processLine(trailing)
  }

  // Finalize buffered tool calls. Backstop per loop.md: even if finish_reason
  // wasn't observed, complete any buffered calls (some relayed paths omit it).
  const toolCalls: AssistantToolCall[] = []
  for (const tc of [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
    if (!tc.id || !tc.name) continue
    toolCalls.push({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.argsBuf || '{}' },
    })
  }

  return { text, toolCalls, finishReason, usage }
}
