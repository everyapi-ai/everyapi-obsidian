import { getJson, type RequestOptions } from './http'

/**
 * A wire surface a model can be called through, mirroring `EndpointType` in backend/internal/constant/endpoint_type.go. The backend resolves this per model AND per routing group (persistence.GetModelsRelayCapabilitiesForGroups), so the same id can carry different values for two keys.
 */
export const ENDPOINT_TYPES = {
  /** `/v1/chat/completions` — the only surface every client in this repo talks. */
  openai: 'openai',
  /** `/v1/responses` (+ the compact variant). NOT chat-completions: the Codex adaptor rejects a chat request at GetRequestURL. */
  openaiResponse: 'openai-response',
  openaiResponseCompact: 'openai-response-compact',
  /** `/v1/messages` (Claude wire). */
  anthropic: 'anthropic',
  /** Gemini `generateContent`. */
  gemini: 'gemini',
  jinaRerank: 'jina-rerank',
  imageGeneration: 'image-generation',
  embeddings: 'embeddings',
  openaiVideo: 'openai-video',
  audioSpeech: 'audio-speech',
  audioTranscription: 'audio-transcription',
} as const

export type EndpointType = (typeof ENDPOINT_TYPES)[keyof typeof ENDPOINT_TYPES]

// Surfaces whose presence proves the model is a non-chat appliance, even when `openai` also appears. That combination is real, not defensive: appcore.GetEndpointTypesByChannelKind publishes [image-generation, openai] for every image generator (and [image-generation, gemini, openai] on the Gemini families) because those models answer on the OpenAI-compatible /v1/images/generations path — the `openai` entry names the wire dialect, not the chat endpoint. Without this set, dall-e-3 and Qwen/Qwen-Image would pass a "contains openai" test and land in a chat picker.
const NON_CHAT_ENDPOINT_TYPES: ReadonlySet<string> = new Set<string>([
  ENDPOINT_TYPES.imageGeneration,
  ENDPOINT_TYPES.embeddings,
  ENDPOINT_TYPES.openaiVideo,
  ENDPOINT_TYPES.audioSpeech,
  ENDPOINT_TYPES.audioTranscription,
  ENDPOINT_TYPES.jinaRerank,
])

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
  /**
   * API surfaces the model can be called through for THIS key's routing groups, e.g. `['openai', 'anthropic']`. See {@link isChatModel} for how to read it — in particular, an empty array is a positive statement ("no synchronous surface"), not missing data.
   */
  supported_endpoint_types?: EndpointType[] | string[] | null
  /**
   * True when the gateway itself translates `/v1/chat/completions` into a Responses-only upstream (every eligible ability is on the Codex family). It is a gateway guarantee, not an upstream-native endpoint, which is why the backend keeps it out of `supported_endpoint_types` — so a chat filter that ignores it hides models that ARE chat-callable. Omitted (undefined) when the guarantee is unavailable.
   */
  chat_completions_bridge?: boolean
  /** `'chat'` for chat-shaped models, `'task'` for submit-then-poll media platforms; omitted when the backend hasn't classified the model. Never infer "synchronous" from its absence. */
  endpoint_kind?: string
  /** Whether `reasoning_effort` / `reasoning` are safe to send. `false`/absent means UNKNOWN, not "definitely unsupported" (dto.OpenAIModels marks it `omitempty`). */
  supports_thinking?: boolean
  /** Longest clip a video model produces, in seconds. Absent = no constraint information, NOT "unlimited". */
  max_duration_seconds?: number
}

interface ModelsResponse {
  data?: GatewayModel[]
}

/** GET `{base}/models` — the live, OpenAI-compatible model catalog. */
export async function fetchModels(opts: RequestOptions): Promise<GatewayModel[]> {
  const body = await getJson<ModelsResponse>(`${opts.baseUrl}/models`, opts)
  return (body.data ?? []).filter((m) => m.id)
}

/**
 * Whether a catalogue entry can serve a `POST /v1/chat/completions` request — the one call every chat surface in this repo makes. Use it to build any chat model picker and to validate a saved/default model; a model that fails this test cannot answer a chat message at all, so offering it guarantees an error on the user's first send.
 *
 * The rule, read out of the backend rather than guessed:
 *
 *  1. `chat_completions_bridge: true` wins outright. The gateway converts the chat request to Responses for a Codex-family model, so `['openai-response']` alone is still chat-callable (persistence.GetModelsRelayCapabilitiesForGroups sets the flag exactly when the surface is response-only and every ability is Codex).
 *  2. `supported_endpoint_types` absent or `null` means UNKNOWN — allow. dto.OpenAIModels declares the field without `omitempty`, so any EveryAPI build always serialises an array; a missing/`null` field therefore means the responder is not an EveryAPI gateway of this vintage (an older self-hosted build, or a third-party OpenAI-compatible base URL a user configured). Filtering those catalogues down to nothing would be worse than showing them whole.
 *  3. An EMPTY array means NOT chat. This is the case that matters and the one an "empty = unknown" reading gets wrong: appcore.GetEndpointTypesByChannelKind returns `[]` deliberately for the submit-then-poll task platforms (`kling`, `vidu`, `suno`), for every model whose output modality is video, and for an image-shaped name on the Codex family. Those models have no synchronous surface at all, so an empty list is the backend saying "task-only media model", exactly as web/CLAUDE.md documents it.
 *  4. A non-empty `output_modalities` that does not include `text` disqualifies. This is the same authoritative modality signal the dashboard's own picker uses (apps/dashboard/src/lib/chat-models.ts) and it is an independent second line: a media model seeded in modelcaps but hosted on a channel kind whose family resolves to a chat surface is caught here even though its endpoint types look chat-shaped. An empty/absent array is unknown and falls through, so a mis-seeded `[]` can never hide a real chat model.
 *  5. Any {@link NON_CHAT_ENDPOINT_TYPES} entry disqualifies, even alongside `openai` — see that set's comment.
 *  6. Otherwise the list must actually contain `openai`. `['openai-response']` without the bridge flag is not enough: the Codex adaptor rejects a chat-completions URL outright.
 *
 * There is deliberately NO id-pattern fallback here. Classification by id is how the clients in this repo drifted from the backend in the first place (a hand-written regex misses `MiniMax-Hailuo-*`, invents platforms the backend never wired up, and breaks on org-prefixed ids such as `Qwen/Qwen-Image`); when this function passes a media model, the fix is a modelcaps row or a `models.endpoints` override on the backend, not another regex here.
 */
export function isChatModel(model: GatewayModel): boolean {
  if (model.chat_completions_bridge === true) return true
  const outputs = model.output_modalities
  if (outputs && outputs.length > 0 && !outputs.includes('text')) return false
  const endpoints = model.supported_endpoint_types
  if (endpoints == null) return true
  if (!endpoints.length) return false
  const normalized = endpoints.map((endpoint) => String(endpoint).toLowerCase())
  if (normalized.some((endpoint) => NON_CHAT_ENDPOINT_TYPES.has(endpoint))) return false
  return normalized.includes(ENDPOINT_TYPES.openai)
}

/**
 * The chat-callable subset of a catalogue, in the order the gateway returned it (already alphabetical by id — modelcatalog.ListModels sorts before responding).
 *
 * Deliberately a plain filter with no "everything was rejected, so show it all anyway" escape hatch: a key scoped to media models only really does have zero chat models, and re-offering them would put back exactly the guaranteed-to-fail default this filter exists to prevent. A caller must handle the empty result as its own state ("no chat models available for this key") rather than falling back to {@link fetchModels}'s raw list.
 */
export function filterChatModels<T extends GatewayModel>(models: T[]): T[] {
  return models.filter((model) => isChatModel(model))
}

/** GET `{base}/models`, keeping only the entries that can serve a chat request. The one call a chat model picker should make; see {@link filterChatModels} for the empty-result contract. */
export async function fetchChatModels(opts: RequestOptions): Promise<GatewayModel[]> {
  return filterChatModels(await fetchModels(opts))
}

/**
 * Resolve the model a chat surface should start with: the saved id when it is still usable, otherwise the first chat model in the catalogue, otherwise `''`.
 *
 * Keeps a saved id that the catalogue does not list at all (an alias an older gateway omits from `/v1/models`, or a model the user typed by hand), but never keeps one the catalogue lists as non-chat, and never auto-selects a non-chat model as the default — the two halves of the shared-chat-model-filter acceptance rule.
 */
export function resolveChatModel(models: GatewayModel[], savedModel: string): string {
  const saved = savedModel.trim()
  const catalogued = saved ? models.find((model) => model.id === saved) : undefined
  if (saved && (!catalogued || isChatModel(catalogued))) return saved
  return filterChatModels(models)[0]?.id ?? ''
}
