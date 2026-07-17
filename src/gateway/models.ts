import { getJson, type RequestOptions } from './http'

export interface GatewayModel {
  id: string
  owned_by?: string
  /** Max input context in tokens. `/v1/models` reports this as `context_window`. */
  context_window?: number
  /** Per-model output-token cap, where the gateway exposes one. */
  max_output?: number
  /** Accepted input types, e.g. `['text', 'image', 'pdf']`. Absent when the gateway hasn't classified the model. */
  input_modalities?: string[]
  /** Produced output types, e.g. `['text']`. */
  output_modalities?: string[]
  /** API surfaces the model can be called through, e.g. `['openai', 'anthropic']`. */
  supported_endpoint_types?: string[]
}

interface ModelsResponse {
  data?: GatewayModel[]
}

/** GET `{base}/models` — the live, OpenAI-compatible model catalog. */
export async function fetchModels(opts: RequestOptions): Promise<GatewayModel[]> {
  const body = await getJson<ModelsResponse>(`${opts.baseUrl}/models`, opts)
  return (body.data ?? []).filter((m) => m.id)
}
