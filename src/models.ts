// What the model picker (settings dropdown and the in-chat model chip) may offer, and what to say
// when it can offer nothing.
//
// Both surfaces read the same `/v1/models` catalog and both feed the SAME thing: the model id that
// `/v1/chat/completions` is called with. So they inherit the same hazard the browser extension and
// the Raycast extension already close — an image/video generator, a TTS/ASR model, an embedding or a
// reranker offered in a chat picker makes every send fail, and nothing on the picker screen warned
// about it. On this gateway that is not hypothetical: its own price catalog ships
// `doubao-seedream-5.0-lite` (image), `doubao-seedance-2.0` (video), `seed-tts-2.0` (speech) and
// `doubao-embedding-vision` (embeddings) in the same access group as chat models.
//
// The eligibility judgement is NOT re-derived here — it is `isChatEligible` from
// @everyapi-ai/gateway, which this plugin already bundles. Its documented asymmetry carries over
// unchanged: a model the backend has not classified in terms this client recognises is
// UNCLASSIFIED, never "cannot chat", so it stays on offer.

import { isChatEligible, type GatewayModel } from '@everyapi-ai/gateway'

/**
 * Why a picker has nothing to offer. Two facts, kept apart on purpose: "this key sees no models on
 * this gateway at all" and "this key sees models, none of which can chat" are different states of
 * the account and want different words. Collapsing them makes the UI assert the second while the
 * first is true — reachable with no mis-configuration at all, just an empty `{"data":[]}`.
 * apps/raycast/src/lib/model-choices.ts and the browser extension draw the same line on the same
 * endpoint.
 */
export type ChatModelsEmptyReason = 'no-models' | 'no-chat-models'

export type ChatModels =
  | { kind: 'ready'; models: GatewayModel[] }
  | { kind: 'empty'; reason: ChatModelsEmptyReason }

/**
 * The chat-capable subset of a `/v1/models` catalog.
 *
 * @param catalog rows as read from the gateway. An unreadable catalog should be passed as `[]` only
 *   when the caller has its own words for the failure (the plugin shows `notice.modelsLoadFailed`
 *   and falls back to a free-text field) — this function cannot tell "request failed" from "the
 *   account really has nothing", so it reports the honest lower bound, `no-models`.
 */
export function resolveChatModels(catalog: GatewayModel[]): ChatModels {
  const models = catalog.filter((m) => isChatEligible(m))
  if (models.length > 0) return { kind: 'ready', models }
  return { kind: 'empty', reason: catalog.length === 0 ? 'no-models' : 'no-chat-models' }
}
