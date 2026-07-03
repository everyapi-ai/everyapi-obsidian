// Batch embeddings over the OpenAI-compatible `/v1/embeddings` endpoint. Mirrors
// chat.ts/http.ts: same auth headers, the same signal/timeout resolution, and a
// plain `fetch` POST with a JSON body — no SDK. Used by the VS Code assistant's
// opt-in codebase index (bulk-embed on an explicit user command) and by its
// search_codebase tool (one short query embed at search time).

import { authHeaders, redactSecrets, resolveSignal, safeReadText, type RequestOptions } from './http'

export interface EmbedUsage {
  prompt_tokens?: number
  total_tokens?: number
}

export interface EmbedInput extends RequestOptions {
  model: string
  /** One or more strings to embed in a single request. */
  input: string[]
}

export interface EmbedResult {
  /**
   * One vector per input string, aligned by each response entry's `index` to
   * the corresponding position in `input` (not by response order). A sparse or
   * dropped upstream response throws rather than returning misaligned vectors.
   */
  embeddings: number[][]
  usage?: EmbedUsage
}

interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: number[] }>
  usage?: EmbedUsage | null
  error?: { message?: string; type?: string; code?: string } | string
}

/**
 * Embed a batch of strings. Honors {@link RequestOptions.signal}/`timeoutMs`
 * (a large batch can be slow, so callers should pass a generous timeout). The
 * returned vectors are aligned to `input` by each entry's `index` — OpenAI may
 * emit `data` out of order, so we slot each embedding into its index position.
 * If the response is sparse (an index missing), alignment can't be guaranteed
 * and the call throws instead of silently returning misaligned vectors.
 */
export async function embed(input: EmbedInput): Promise<EmbedResult> {
  const body = {
    model: input.model,
    input: input.input,
  }

  const res = await fetch(`${input.baseUrl}/embeddings`, {
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
    const detail = res.body ? redactSecrets(await safeReadText(res.body)) : ''
    throw new Error(
      `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`
    )
  }

  const json = (await res.json()) as EmbeddingsResponse
  // Some gateways return HTTP 200 with a top-level `error` body instead of a
  // non-2xx status (same pattern as chat.ts's completeChat/streamChat).
  // Without this, `json.data` is absent and the code below would silently
  // return an empty embeddings array as if the batch succeeded, instead of
  // surfacing why nothing got embedded.
  if (json.error) {
    throw new Error(
      redactSecrets(
        typeof json.error === 'string' ? json.error : (json.error.message ?? 'upstream error')
      )
    )
  }
  const data = json.data ?? []
  // No data at all (an empty input batch or an absent `data` field) is a
  // degenerate case with nothing to align — return empty rather than fabricate
  // placeholder vectors.
  if (data.length === 0) {
    return { embeddings: [], usage: json.usage ?? undefined }
  }
  // Slot each embedding into its own `index` position so an out-of-order or
  // sparse response can't shift vectors onto the wrong input.
  const rows = Array.from<number[]>({ length: input.input.length })
  let filled = 0
  for (const d of data) {
    const i = d.index ?? -1
    if (i >= 0 && i < rows.length && d.embedding && rows[i] === undefined) {
      rows[i] = d.embedding
      filled++
    }
  }
  // A conforming endpoint returns exactly one vector per input; a dropped index
  // would otherwise silently misalign every vector against its source. Count
  // filled slots explicitly — `rows.some()` would skip the sparse-array holes.
  if (filled !== input.input.length) {
    throw new Error(
      `embeddings response misaligned: expected ${input.input.length} vectors, got ${filled}`
    )
  }
  return {
    embeddings: rows,
    usage: json.usage ?? undefined,
  }
}
