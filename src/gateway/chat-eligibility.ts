// Whether a model can serve a chat request — the one filter a chat surface (browser-extension popup, Raycast Ask / Switch Default Model, …) must apply before it puts a model in a picker. Without it an image/video generator, an embedding or a reranker lands in the picker and every send fails.
//
// Two signals, in strict priority order:
//
// 1. `output_modalities` from the gateway model catalog — AUTHORITATIVE, but only when it speaks a vocabulary this client RECOGNISES. A model that outputs text can chat; one that only outputs image / video / audio is a generator and cannot. This is the direct capability signal, so it never mis-drops a real chat model the way an id guess does (MiniMax-M3 is unambiguously chat, and no id pattern can know that).
// 2. An id fallback, reached whenever the backend has not classified the model IN TERMS WE UNDERSTAND. Capability fields are `omitempty`, so an ABSENT field means unknown; an EMPTY array, a malformed value, and — the case that matters most — a non-empty array carrying no recognised token (`['TEXT']`, `['chat']`, `['text/plain']` from a self-hosted or pre-release gateway) all mean the same thing: UNCLASSIFIED, never "outputs nothing / not chat".
//
// WHY THE VOCABULARY CHECK IS THE LOAD-BEARING PART. Every chat surface applies this filter to the WHOLE catalog, so a judgement that is wrong for one model in an unusual way is wrong for all 240 of them in the same way: seed the catalog `['TEXT']` and a client that trusts any non-empty array hides every model, tells the user "this key exposes no chat-capable models" — which is false — and disables its composer, with every test still green. Case is therefore folded before comparison and an unrecognised vocabulary defers to the id fallback, so the failure mode of a mis-seed is a SUPERSET (a generator may be offered and its send fails loudly) rather than a dead product that lies about why.
//
// The recognised vocabulary is the backend's own, as documented at packages/api/src/endpoints.ts:124 for the same `dto.OpenAIModels` payload: text / image / video / audio.
//
// RESIDUAL, not defended against here: a backend that confidently mis-seeds a real chat model with a RECOGNISED non-text token (`['image']` for gpt-4o) still hides it. Note the asymmetry that makes this the lesser problem: the vocabulary case is a client-side misreading of a backend that never claimed anything about `text`, this one is the backend making a claim and being wrong, and this project's standing rule is that capability is the backend's to state. There IS a second signal that looks like it could break the tie — `endpoint_kind` (chat / task), documented on the same payload at packages/api/src/endpoints.ts:124 — and repeated live measurements rule it out as an independent signal. On 2026-08-16, one API key's `/v1/models` response contained 8 models: 7 carried `output_modalities` and the same 7 carried `endpoint_kind`; both set differences were empty. On 2026-08-20, the response had changed to 9 models and both fields covered all 9, again with empty set differences. These one-key snapshots do not establish coverage across the site's 240+ models, and their change is exactly why coverage numbers must remain dated. Within both measured responses, however, `endpoint_kind` was populated precisely where `output_modalities` was, so it broke no tie. On a model the backend seeded WRONGLY it would also be the same backend answering the same question a second time. Do not wire it up expecting an independent signal.
//
// `supported_endpoint_types` deliberately plays no part here: it says which API surfaces (`openai` / `anthropic` / `audio-speech`) the model is callable through, not what it can produce. Using it as a chat/non-chat judgement drops a real chat model that happens to be exposed on the `anthropic` surface.
//
// KNOWN GAP (inherited by apps/dashboard/src/lib/chat-models.ts through its import of this module): an unseeded non-chat model whose id matches none of the patterns below defaults to chat. The id fallback only covers the seeding lag; once the backend seeds `output_modalities` the authoritative branch classifies it correctly. Symmetrically, a model the backend seeds as text-output IS offered even when its id looks non-chat (e.g. a transcription model seeded `['text']`) — that is the backend being the source of truth, and the fix for a wrong verdict belongs in the backend's capability seed, not in a client-side veto.
//
// TYPESCRIPT TOPOLOGY: ONE SHARED IMPLEMENTATION, PLUS ONE SELF-CONTAINED COPY. This is the shared original used by gateway consumers including the dashboard's thin adapter at apps/dashboard/src/lib/chat-models.ts. apps/raycast/src/lib/chat-eligibility.ts remains a DELIBERATE duplicate because the Raycast extension ships a self-contained bundle to the Raycast Store and declares no `@everyapi-ai/*` workspace dependency (docs/web/raycast.md). The fixture table is imported by the gateway and dashboard test suites; the gateway suite runs both the shared implementation and Raycast copy over every row, so the fixtures cover gateway, Raycast and dashboard. It additionally compares the shared and Raycast pattern sources and recognised vocabulary. This paragraph is deliberately scoped to TypeScript: non-TS clients that cannot import the module need their own machine parity, and fixture replay alone does not prove regex sources or vocabulary constants stayed identical unless those are compared too. plugins-ci.yml runs the TypeScript lockstep test on any change under apps/raycast/** or packages/gateway/**, so an unmirrored Raycast edit normally goes red on the PR. Both "normally" and "goes red" — rather than "is blocked" — are the honest words. It reports rather than blocks because whether a check gates a merge is set by branch protection outside this repo, which this repo's own workflows record as not done: app-tests.yml:72-76 ("NOT YET A MERGE GATE", and a red check does not by itself stop a deploy, because Workers Builds ships on every push to main independently of Actions) and dashboard-i18n-check.yml:7-8. It is only "normally" because the trigger is a GitHub `paths:` filter, and this repo has already been bitten once by path filtering silently missing files in a very large squash merge (see the note in .github/workflows/mcp-release.yml, which is the only workflow hardened against it). So a drift landing inside a 300-file squash reaches main unchecked, and one that does go red still lands if someone merges anyway. The dashboard's modality judgement itself no longer drifts: it imports this module. Its old modality-level catalog fail-open was removed. A separate fail-open remains in playground.tsx for route-group selection (`filtered.length > 0 ? filtered : chatModelEntries`), deliberately covering unavailable pricing or a group filter that would empty the picker; it does not weaken modality classification.

/** The minimal shape needed to judge chat eligibility — a `GatewayModel`, or any raw `/v1/models` row. */
export interface ChatEligibilityInput {
  id: string
  output_modalities?: string[]
}

/** An `output_modalities` entry meaning "can produce a chat reply". Input modality is irrelevant: image/audio IN, text OUT (gpt-4o) is a chat model. */
export const CHAT_OUTPUT_MODALITY = 'text'

// The output-modality vocabulary this client understands, per packages/api/src/endpoints.ts:124 (same dto.OpenAIModels payload). An array carrying none of these says nothing we can act on — see the vocabulary note at the top of this file. Kept deliberately small: a token added here on a guess would turn "unclassified, fall back" into a confident hide.
export const KNOWN_OUTPUT_MODALITIES: readonly string[] = ['text', 'image', 'video', 'audio']

// Audio-only (TTS / STT) + embedding + rerank ids. Deliberately narrow so a real chat model is never hidden: bare `audio` is NOT matched, because gpt-4o-audio-preview is a chat model that merely takes/returns audio over /v1/chat/completions.
export const NON_CHAT_ID_RE =
  /(whisper|(^|[-_/])tts([-_.\d]|$)|embedding|reranker?|transcrib|text-to-speech)/i

// Aggregate media-platform ids ending in `-video` / `-image`: the backend's task-platform ChannelName can itself be enabled as a callable model (doubao-video, hailuo-video). A `-video` / `-image` suffix is an unambiguous generation surface; chat model ids never end that way.
export const MEDIA_PLATFORM_ID_RE = /[-_](video|image)$/i

// Media GENERATOR ids — image (Midjourney, DALL·E, GPT-Image, Imagen, Seedream, Flux, Qwen/Wan image, z-image), video (Veo, Sora, Kling, MiniMax-Hailuo, Seedance, Jimeng, Vidu, Wan) and music (Suno). Mirrors apps/dashboard/src/lib/media-models.ts, which derives them from the backend's real task adaptors rather than from guesses.
export const MEDIA_GEN_ID_RE =
  /(^midjourney|^mj[-_]|^dall-?e|^gpt-image|^imagen|seedream|^black-forest-labs\/flux|^flux[-.]|^qwen-image|^z-image|image-generation|^veo[-.]|^sora[-.]|^kling[-.]|minimax-hailuo|seedance|^jimeng|^vidu|^wan[0-9.]|^suno[-_])/i

/**
 * The recognised, case-folded tokens of an `output_modalities` value — empty when the backend
 * said nothing this client can act on (absent, `[]`, malformed, or an unrecognised vocabulary).
 */
function recognisedModalities(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => KNOWN_OUTPUT_MODALITIES.includes(entry))
}

/**
 * Whether `model` belongs in a chat picker.
 *
 * @param model an object carrying at least `id`; `output_modalities` when the backend has classified it.
 */
export function isChatEligible(model: ChatEligibilityInput): boolean {
  // Authoritative branch — entered only when the value carries at least one token we recognise. That guard is not ceremony: Raycast reads this field off the OpenAI SDK's Model type, where it is not declared, so a string/null/object arrives unchecked, and a gateway seeded in a different vocabulary would otherwise silently classify an entire catalog as non-chat.
  const known = recognisedModalities(model.output_modalities)
  if (known.length > 0) return known.includes(CHAT_OUTPUT_MODALITY)
  const id = model.id
  if (NON_CHAT_ID_RE.test(id)) return false
  if (MEDIA_PLATFORM_ID_RE.test(id)) return false
  if (MEDIA_GEN_ID_RE.test(id)) return false
  return true
}
