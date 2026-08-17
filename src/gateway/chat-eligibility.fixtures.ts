// The ONE fixture table both chat-eligibility implementations are judged against — this package's `isChatEligible` and the deliberate duplicate at apps/raycast/src/lib/chat-eligibility.ts (Raycast ships a self-contained Store bundle and may not depend on a workspace package, so the code is copied on purpose; this table is what keeps the two verdicts identical).
//
// Ids and modality shapes are REAL: they come from the backend's capability seed as already asserted in apps/dashboard/src/lib/chat-models.test.ts (chat/multimodal → ['text'], image generators → ['image'], video → ['video']), so the table is grounded in what the gateway actually returns rather than in invented examples.
//
// The one deliberate exception is the `unrecognisedVocabulary` group: `['chat']` / `['text/plain']` / `['TEXT']` are NOT shapes observed from this backend — they stand for any gateway whose seed does not match the vocabulary at packages/api/src/endpoints.ts:124 (a self-hosted deployment, a pre-release build, a future rename). They are in the table because the base URL is user-editable on both client surfaces, so "some other gateway answered" is a real configuration, not a thought experiment.
//
// Not exported from index.ts on purpose: consumers bundle this package from source, and test fixtures have no business in a shipped bundle.

export type CounterexampleDirection =
  /** The id fallback would say CHAT, the backend's metadata says it does not output text → metadata must win and hide it. */
  | 'id-says-chat-metadata-says-not-text'
  /** The id fallback would say NON-CHAT, the backend's metadata says it outputs text → metadata must win and keep it. */
  | 'id-says-non-chat-metadata-says-text'

export interface ChatEligibilityFixture {
  id: string
  /** Absent = the backend has not seeded this model (the id-fallback path). */
  output_modalities?: string[]
  /** Present only to prove it is IGNORED: API surface is not a capability. */
  supported_endpoint_types?: string[]
  eligible: boolean
  why: string
  counterexample?: CounterexampleDirection
  /**
   * The value is a non-empty array whose tokens are NOT in the recognised vocabulary, so it must be
   * read as UNCLASSIFIED and decided by the id fallback alone. Flagged so a test can assert the
   * verdict really is the pure-fallback verdict — i.e. that the metadata was ignored, not obeyed.
   */
  unrecognisedVocabulary?: true
  /**
   * This case's id has the OPPOSITE fallback verdict to its expected one, so passing it requires the
   * metadata to have been read correctly. Flagged so a test can assert that claim instead of leaving it
   * to a comment: a case that agrees with the fallback proves nothing about the path it is named for.
   */
  discriminating?: true
}

export const CHAT_ELIGIBILITY_FIXTURES: ChatEligibilityFixture[] = [
  // ---- authoritative branch: output_modalities present ----
  { id: 'gpt-4o', output_modalities: ['text'], eligible: true, why: 'text output → chat' },
  {
    id: 'claude-opus-4-8',
    output_modalities: ['text'],
    supported_endpoint_types: ['anthropic'],
    eligible: true,
    why: 'text output on the anthropic API surface — supported_endpoint_types must not exclude it',
  },
  {
    id: 'MiniMax-M3',
    output_modalities: ['text'],
    eligible: true,
    why: 'regression: a text model no id pattern could recognise must never be dropped',
  },
  {
    id: 'gpt-4o-audio-preview',
    output_modalities: ['text'],
    eligible: true,
    why: 'multimodal: audio in, text out → chat',
  },
  {
    id: 'gpt-image-2',
    output_modalities: ['image'],
    eligible: false,
    why: 'image generator — no text output',
  },
  {
    id: 'doubao-seedream-4-0-250828',
    output_modalities: ['image'],
    eligible: false,
    why: 'image generator — no text output',
  },
  {
    id: 'sora-2-pro',
    output_modalities: ['video'],
    eligible: false,
    why: 'video generator — no text output',
  },
  {
    id: 'tts-1',
    output_modalities: ['audio'],
    supported_endpoint_types: ['audio-speech'],
    eligible: false,
    why: 'speech synthesis — audio output only',
  },

  // ---- counterexample direction 1: the id fallback would say CHAT, metadata says otherwise ----
  {
    id: 'gpt-4o-audio-preview',
    output_modalities: ['audio'],
    eligible: false,
    counterexample: 'id-says-chat-metadata-says-not-text',
    why: 'same id as the eligible fixture above and NOT matched by any non-chat pattern (bare "audio" is deliberately unmatched), so the id fallback alone would offer it; seeded audio-only it must be hidden',
  },
  {
    id: 'gemini-2.5-flash-image-preview',
    output_modalities: ['image'],
    eligible: false,
    counterexample: 'id-says-chat-metadata-says-not-text',
    why: 'a real image model whose id escapes the `-image` SUFFIX pattern (it ends `-preview`), so only the backend metadata can hide it',
  },

  // ---- counterexample direction 2: the id fallback would say NON-CHAT, metadata says text ----
  {
    id: 'whisper-1',
    output_modalities: ['text'],
    eligible: true,
    counterexample: 'id-says-non-chat-metadata-says-text',
    why: 'NON_CHAT_ID_RE matches `whisper`, so the fallback would hide it; the backend saying it outputs text must win — the id regex is a fallback, never a veto',
  },
  {
    id: 'gpt-4o-mini-transcribe',
    output_modalities: ['text'],
    eligible: true,
    counterexample: 'id-says-non-chat-metadata-says-text',
    why: 'NON_CHAT_ID_RE matches `transcrib`; metadata still wins',
  },

  // ---- unknown metadata must fall through to the id fallback, never hide everything ----
  {
    id: 'MiniMax-M3',
    output_modalities: [],
    eligible: true,
    why: 'empty array = unknown, NOT "no output" — a mis-seeded [] must not hide a chat model',
  },
  {
    id: 'doubao-video',
    output_modalities: [],
    eligible: false,
    why: 'empty array falls through to the id fallback, which still catches the aggregate video platform channel',
  },

  // ---- an UNRECOGNISED vocabulary is unknown too — the catalog-wide failure this module exists to prevent ----
  // A self-hosted or pre-release gateway that seeds a vocabulary of its own hits EVERY model at once. Reading such a
  // value as authoritative empties the picker, disables the composer and tells the user their key exposes no
  // chat-capable models — a false statement, with every test still green. These fixtures pin the opposite.
  {
    id: 'MiniMax-M3',
    output_modalities: ['chat'],
    eligible: true,
    unrecognisedVocabulary: true,
    why: 'a gateway seeding `chat` instead of `text` classifies nothing we can act on — the model must survive on the id fallback, not be hidden',
  },
  {
    id: 'deepseek-chat',
    output_modalities: ['text/plain'],
    eligible: true,
    unrecognisedVocabulary: true,
    why: 'a MIME-shaped token is not the `text` token; unclassified, so the id fallback keeps a real chat model',
  },
  {
    id: 'dall-e-3',
    output_modalities: ['chat'],
    eligible: false,
    unrecognisedVocabulary: true,
    why: 'the same unrecognised vocabulary must not become a blanket yes either — the id fallback still hides a generator',
  },
  {
    id: 'whisper-1',
    output_modalities: ['text/plain'],
    eligible: false,
    unrecognisedVocabulary: true,
    why: 'a token that merely CONTAINS `text` is not the `text` token: matching on substrings would resurrect this as chat, and the id fallback is what must decide',
  },

  // ---- recognised vocabulary, awkward spelling: fold case/whitespace rather than fall back ----
  // The cases carrying `discriminating: true` pair an awkward spelling with an id whose FALLBACK verdict is the
  // OPPOSITE, so the assertion can only pass if the value was really read: the same spelling against a chat-looking id
  // would reach the right answer for the wrong reason and prove nothing. The rest are the ordinary realistic shapes,
  // kept for documentation — they are not evidence, and a test guards that claim rather than trusting this paragraph.
  {
    id: 'whisper-1',
    output_modalities: ['TEXT'],
    eligible: true,
    discriminating: true,
    why: 'case is folded, so this stays authoritative and beats an id fallback that would hide `whisper`',
  },
  {
    id: 'whisper-1',
    output_modalities: [' Text '],
    eligible: true,
    discriminating: true,
    why: 'padding is trimmed before comparison — same discriminating id, so an untrimmed implementation hides it',
  },
  {
    id: 'gemini-2.5-flash-image-preview',
    output_modalities: ['IMAGE'],
    eligible: false,
    discriminating: true,
    why: 'folding is symmetric: an upper-cased `image` authoritatively hides a model whose id escapes every pattern',
  },
  {
    id: 'whisper-1',
    output_modalities: ['text', 'thinking'],
    eligible: true,
    discriminating: true,
    why: 'ONE recognised token is enough to make the value authoritative — an implementation demanding that every token be known would fall back and hide it',
  },
  {
    id: 'whisper-1',
    output_modalities: ['image', 'text'],
    eligible: true,
    discriminating: true,
    why: 'TWO recognised tokens with `text` SECOND — a model that outputs both can chat. An implementation reading only the first recognised token, or demanding exactly one, hides it; so does the id fallback, so this passes only if the whole list is searched',
  },
  {
    id: 'whisper-1',
    output_modalities: ['text', 'image'],
    eligible: true,
    discriminating: true,
    why: 'the mirror of the case above, `text` FIRST: without it an implementation reading only the LAST recognised token passes the whole table. Position must not matter at all',
  },
  {
    id: 'gemini-2.5-flash-image-preview',
    output_modalities: ['image', 'MUSIC'],
    eligible: false,
    discriminating: true,
    why: 'partial recognition on the HIDING side, against an id the fallback would KEEP: one understood token is enough to hide confidently, and an unknown companion must not drag the value back to unclassified',
  },
  {
    id: 'gpt-4o',
    output_modalities: ['TEXT'],
    eligible: true,
    why: 'the ordinary upper-cased seed, kept alongside the discriminating cases as the realistic shape',
  },
  {
    id: 'gpt-image-2',
    output_modalities: [' Image '],
    eligible: false,
    why: 'the ordinary padded/capitalised generator seed',
  },
  {
    id: 'gpt-4o',
    output_modalities: ['text', 'thinking'],
    eligible: true,
    why: 'the ordinary mixed-token chat seed — the discriminating version of this claim is the whisper-1 case above',
  },
  {
    id: 'sora-2-pro',
    output_modalities: ['video', 'MUSIC'],
    eligible: false,
    why: 'the ordinary mixed-token generator seed — the discriminating version is the gemini image-preview case above',
  },

  // ---- id fallback: unseeded models (output_modalities absent) ----
  { id: 'gpt-4o', eligible: true, why: 'unseeded chat model passes untouched' },
  { id: 'deepseek-chat', eligible: true, why: 'unseeded chat model passes untouched' },
  { id: 'claude-sonnet-5', eligible: true, why: 'unseeded chat model passes untouched' },
  {
    id: 'doubao-seed-1-6-thinking-250715',
    eligible: true,
    why: 'ByteDance chat family — `seed-` must not be confused with `seedance`',
  },
  {
    id: 'doubao-1-5-vision-pro-32k',
    eligible: true,
    why: 'vision INPUT, text output — a chat model',
  },
  {
    id: 'gpt-4o-audio-preview',
    eligible: true,
    why: 'bare "audio" is deliberately unmatched: this is a chat model over /v1/chat/completions',
  },
  { id: 'whisper-1', eligible: false, why: 'speech-to-text' },
  { id: 'gpt-4o-mini-tts', eligible: false, why: 'speech synthesis' },
  { id: 'tts-1-hd', eligible: false, why: 'speech synthesis' },
  { id: 'text-embedding-3-small', eligible: false, why: 'embeddings' },
  { id: 'bge-reranker-large', eligible: false, why: 'reranker' },
  { id: 'mj_imagine', eligible: false, why: 'Midjourney image generation' },
  { id: 'dall-e-3', eligible: false, why: 'image generation' },
  { id: 'veo-3.1-generate-preview', eligible: false, why: 'video generation' },
  { id: 'suno_music', eligible: false, why: 'music generation' },
  {
    id: 'doubao-video',
    eligible: false,
    why: 'aggregate video platform channel enabled as a model',
  },
  {
    id: 'hailuo-video',
    eligible: false,
    why: 'aggregate video platform channel enabled as a model',
  },
]
