// The EveryAPI agentic tool-call loop for the Obsidian surface (contracted by @everyapi-ai/agent-contract). Ported from apps/vscode/src/agent/loop.ts — the loop itself is host-agnostic; only the auth header differs (Obsidian runs in Electron's fetch, where User-Agent is silently dropped, so we identify the surface via X-Client-App instead of userAgent — same as the gateway's streamChat).
//
// Drives a multi-turn conversation against the EveryAPI gateway in pure OpenAI shape: it sends the `tools` array and `tool_choice: "auto"`, parses the assistant's `tool_calls`, runs each through the per-host executors (which enforce safety), appends one `role:"tool"` message per call, and repeats until the assistant stops calling tools or the iteration cap is hit.
//
// The transport is @everyapi-ai/gateway's streamChat — the single SSE client every EveryAPI surface shares. It carries the `tools` array, accumulates fragmented tool-call deltas by their `index` slot, flushes the TextDecoder so a stream ending mid multi-byte character keeps its closing frame, and replays a non-SSE 200 completion body (the shape iOS WKWebView and a gateway that ignores `stream: true` produce). This module owns only the agentic control flow on top of it.

import { streamChat, type ChatTool, type ChatUsage } from '@everyapi-ai/gateway'

import { throwIfAborted } from './abort'
import { resultToString } from './diff'
import type { VaultExecutors } from './executors'
import { AGENT_TOOLS, isToolName, TOOL_NAMES } from './tools'

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

/** Re-exported rather than redeclared: the loop hands the gateway's usage block straight to the view, and a local copy is exactly how the two would drift. */
export type { ChatUsage } from '@everyapi-ai/gateway'

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
  usage: ChatUsage | undefined
}

/** Run the agentic loop to completion. Returns the final assistant text. Tool execution is gated inside the executors (approval for mutating tools); a denied/failed tool produces a structured result the model can react to, so the loop never throws on a tool failure — only on a transport/HTTP error. */
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

    // Execute each call sequentially (loop.md: deterministic ordering, and a later mutating call may depend on an earlier one). One tool message per call, preserving tool_call_id.
    for (const call of turn.toolCalls) {
      throwIfAborted(input.signal)
      const resultStr = await runOneCall(input, call, failStreak)
      messages.push({ role: 'tool', tool_call_id: call.id, content: resultStr })
    }
    // A Stop pressed during the LAST call of a turn would otherwise only surface on the next round trip's fetch; check here so the turn ends as a cancellation the moment the executor returns.
    throwIfAborted(input.signal)
  }

  // Iteration cap reached: make one final non-tool request so the model can summarize where it got to, then surface that as the (truncated) answer.
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
    /* disableTools */ true
  )
  // The summarize round trip is a billable request like every in-loop turn, and the host sums each onUsage into one turn total (view.ts's mergeUsage), so skipping it here silently dropped the tokens AND the cost of the largest request of the run — it carries the entire accumulated message history — from what the user is shown for a truncated turn.
  if (final.usage) input.onUsage?.(final.usage)
  return { text: final.text || lastText, iterations: MAX_ITERATIONS, truncated: true }
}

/** Execute a single tool call and return its result-envelope string. */
async function runOneCall(
  input: AgentLoopInput,
  call: AssistantToolCall,
  failStreak: Map<string, number>
): Promise<string> {
  const name = call.function.name
  if (!isToolName(name)) {
    return resultToString({
      status: 'error',
      error: `Unknown tool '${name}'.`,
      suggestion: `Call one of: ${TOOL_NAMES.join(', ')}.`,
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
      suggestion:
        'Re-read the note from scratch or ask the user to clarify before trying this target again.',
    })
  }

  input.onToolEvent?.({ name, args, status: 'running' })
  const result = await input.executors.execute(name, args, input.signal)
  input.onToolEvent?.({ name, args, status: result.status === 'ok' ? 'ok' : result.status })

  if (result.status === 'error') failStreak.set(targetKey, (failStreak.get(targetKey) ?? 0) + 1)
  else failStreak.delete(targetKey)

  return resultToString(result)
}

// ---- one model round trip (streaming, via the shared SSE client) --------------

/** One model round trip. Streams assistant text through `onTextDelta` for live UI and returns the turn's finished tool calls, which OpenAI only completes at end-of-stream. */
async function streamOneTurn(
  input: AgentLoopInput,
  messages: LoopMessage[],
  disableTools = false
): Promise<StreamTurn> {
  const toolCalls: AssistantToolCall[] = []
  let text = ''
  let usage: ChatUsage | undefined

  await streamChat({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    clientApp: input.clientApp,
    model: input.model,
    messages,
    tools: disableTools ? undefined : (AGENT_TOOLS as ChatTool[]),
    // tool_choice is not a reserved key, so it passes through to the upstream unchanged.
    modelOptions: { tool_choice: disableTools ? 'none' : 'auto' },
    signal: input.signal,
    onTextDelta: (chunk) => {
      text += chunk
      input.onTextDelta(chunk)
    },
    onToolCall: (call) => {
      // Forward the upstream's own `arguments` string, never JSON.stringify(call.input): re-serialising a parsed object is not byte-identical, and for a malformed payload it would double-encode the raw text into a JSON string literal.
      toolCalls.push({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
      })
    },
    onUsage: (u) => {
      usage = u
    },
  })

  return { text, toolCalls, usage }
}
