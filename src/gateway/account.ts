// Account-scoped reads under `/api`: wallet/balance, the usage log, and a client-side rollup of that log. All authenticated with the same `sk-everyapi-` bearer token (TokenAuthReadOnly on the backend).

import { getJson, redactSecrets, type RequestOptions } from './http'
import { adminApiBase, isDefaultDeployment, QUOTA_PER_USD } from './url'

export interface WalletData {
  name: string
  total_granted: number
  total_used: number
  total_available: number
  unlimited_quota: boolean
  model_limits: Record<string, unknown> | null
  model_limits_enabled: boolean
  expires_at: number
}

export interface LogRow {
  created_at: number
  model_name: string
  quota: number
  prompt_tokens: number
  completion_tokens: number
}

// The `/api` envelope is `{ code | success, message, data }`. Only an explicit boolean `false` is a rejection — a missing flag (or a non-boolean `code`, which some envelopes use to carry a numeric status) still means success when `data` is present. This matches apps/neovim and apps/raycast; the earlier per-surface clients that required `code === true` rejected valid responses.
interface Envelope<T> {
  code?: unknown
  success?: unknown
  message?: string
  data?: T
}

function envelopeError(body: Envelope<unknown>, apiKey?: string): string | null {
  // Same rationale as chat.ts/embeddings.ts: a 200-OK envelope-level failure message is upstream/proxy-controlled the same way a non-2xx body is, and this package is bundled into the MCP server (fetchWallet's caller forwards a thrown Error verbatim as an LLM-visible tool result) and every editor extension — a reflected Authorization header must not survive into either.
  if (body.code === false || body.success === false) {
    return redactSecrets(body.message || 'gateway rejected the request', apiKey)
  }
  // Some deployments signal failure with a shape this client doesn't special-case above — e.g. a non-boolean error code (`{ code: 40100, message: "token revoked" }`) with no `data` and no boolean success/code flag. That's neither a recognized success (`data` present, or an explicit `code`/`success: true`) nor a recognized failure, so callers that fall back to an empty array on a non-array `data` would otherwise swallow it silently. Surface the message rather than degrade to "no data".
  if (body.message && body.data === undefined && body.code !== true && body.success !== true) {
    return redactSecrets(body.message, apiKey)
  }
  return null
}

/** GET `{admin}/usage/token/` — balance and plan for the presented key. */
export async function fetchWallet(opts: RequestOptions): Promise<WalletData> {
  const url = `${adminApiBase(opts.baseUrl)}/usage/token/`
  const body = await getJson<Envelope<WalletData>>(url, opts)
  const err = envelopeError(body, opts.apiKey)
  if (err) throw new Error(err)
  if (!body.data)
    throw new Error(redactSecrets(body.message || 'gateway returned no usage data', opts.apiKey))
  return body.data
}

/**
 * GET `{admin}/log/token` — recent usage rows (≤1000 server-side).
 *
 * Rejects when `data` is not an array, because on this endpoint a non-array payload is never the empty case. Two independent legs close it: the handler emits a `data` field only *after* a successful query — a query error answers `success: false` with the error text, so "the read failed" can never arrive wearing a `data: null` — and the successful path answers with GORM's `Find(&logs)` into a nil-valued named return, whose scanner allocates before it reads any row (`scan.go` sets `reflect.MakeSlice(type, 0, 20)` whenever the destination slice's `Cap()` is 0; identical in v1.21.15 and v1.25.2). A key with zero calls therefore serializes as `data: []`, not `data: null`. Anything else (`null`, `{}`, `""`, `0`, missing) is a degraded response — a proxy body, an error page, an older or modified handler — and folding it into `[]` renders "$0.00 · 0 requests this week", pixel-identical to a genuinely idle week and invisible to every caller.
 *
 * ⚠ Provenance, so nobody over-trusts the paragraph above: that handler was read in the UPSTREAM open-source backend, not in EveryAPI's own fork, which is not available here. It is corroborated by live behaviour on the public gateway (a 1000-row cap matching the upstream `MaxRecentItems`, and four distinct query parameters ignored — matching a handler that reads none) and by this repo's backend notes, but the fork could still diverge on this line, and the ClickHouse log-store branch was not verifiable at all. The bet is deliberate rather than certain: if it is wrong, a zero-call key sees a loud "usage unavailable" instead of "$0.00" — visible and reportable, rather than the silent wrong number this replaces.
 *
 * ⚠ The opposite is true of {@link fetchPricing} — see the note there before "symmetrizing" the two.
 */
export async function fetchLogs(opts: RequestOptions): Promise<LogRow[]> {
  const url = `${adminApiBase(opts.baseUrl)}/log/token`
  const body = await getJson<Envelope<LogRow[]>>(url, opts)
  const err = envelopeError(body, opts.apiKey)
  if (err) throw new Error(err)
  if (!Array.isArray(body.data))
    throw new Error(
      redactSecrets(
        body.message || 'gateway returned a usage log payload that is not a list of rows',
        opts.apiKey
      )
    )
  return body.data
}

/** GET `{admin}/status` — the deployment's quota→USD peg (`quota_per_unit`). Self-hosted operators can retune it; the public/default deployment returns {@link QUOTA_PER_USD}. Falls back to that default when the field is absent/non-positive or the request fails, so a caller can always format with the result. Pass it to {@link fmtUsd} (and any `quota / peg` math) instead of the hardcoded constant. The endpoint is public, but we still send auth since every other admin read does. ⚠ A bare number cannot say whether it is the deployment's peg or the fallback constant — a caller that RENDERS money should use {@link fetchStatus} and check `quotaPerUnitSource` instead. */
export async function fetchQuotaPerUsd(opts: RequestOptions): Promise<number> {
  try {
    const url = `${adminApiBase(opts.baseUrl)}/status`
    const body = await getJson<Envelope<{ quota_per_unit?: number }>>(url, opts)
    const v = body.data?.quota_per_unit
    return typeof v === 'number' && v > 0 ? v : QUOTA_PER_USD
  } catch {
    return QUOTA_PER_USD
  }
}

/**
 * Where {@link StatusInfo.quotaPerUnit} came from. The peg is the denominator of every USD figure a client renders, so a caller that shows money needs to know whether it is the deployment's own number or one we made up.
 *
 * - `deployment` — `/api/status` reported a positive `quota_per_unit`. Authoritative.
 * - `default` — we fell back to {@link QUOTA_PER_USD} on the public deployment, whose published peg is that constant. Treated as harmless, so no surface warns. ⚠ Known residue: this asserts correctness from the HOST, not from a value anybody read — the backend keeps QuotaPerUnit as a mutable setting, so if the public deployment ever retunes it, `default` launders a wrong divisor more quietly than `assumed` would. Nothing here or in CI pins the constant to the deployment's live peg.
 * - `assumed` — we fell back to {@link QUOTA_PER_USD} on some other host. A self-hosted operator can retune QuotaPerUnit, so every USD figure derived from this peg may be wrong by that factor. **This is the state a money-rendering surface must make visible.**
 */
export type QuotaPegSource = 'deployment' | 'default' | 'assumed'

export interface StatusInfo {
  /** quota→USD peg; falls back to {@link QUOTA_PER_USD}. */
  quotaPerUnit: number
  /** Whether {@link quotaPerUnit} is the deployment's own number or a fallback — see {@link QuotaPegSource}. */
  quotaPerUnitSource: QuotaPegSource
  /** Deployment build version ('' when the field is absent). */
  version: string
  /** Process start time, unix seconds (0 when absent) — derive uptime from it. */
  startTime: number
  /** Operator-set deployment name ('' when absent). */
  systemName: string
}

/**
 * GET `{admin}/status` — deployment identity + the quota→USD peg in one read. A richer sibling of {@link fetchQuotaPerUsd} for callers that also want to show which deployment/version a key is hitting (e.g. a status tooltip). The endpoint is public; we send auth like every other admin read.
 *
 * Never throws — every field falls back so a caller can always render. That is deliberate: the peg is a decoration on top of the wallet read, and losing the whole panel because one auxiliary endpoint 5xx'd would be a worse trade. But not throwing used to mean the fallback was *undetectable*: the hardcoded {@link QUOTA_PER_USD} became the divisor of every dollar the client showed with nothing, anywhere, able to tell. {@link StatusInfo.quotaPerUnitSource} is the repair — the failure is still absorbed, but it is no longer erased, and `assumed` names exactly the case where the constant is a guess rather than a documented value.
 */
export async function fetchStatus(opts: RequestOptions): Promise<StatusInfo> {
  // Only reached when the live value is unusable; on the public host the constant IS the published peg, so it is a fallback in provenance only.
  const fallbackSource: QuotaPegSource = isDefaultDeployment(opts.baseUrl) ? 'default' : 'assumed'
  try {
    const url = `${adminApiBase(opts.baseUrl)}/status`
    const body = await getJson<
      Envelope<{
        quota_per_unit?: number
        version?: string
        start_time?: number
        system_name?: string
      }>
    >(url, opts)
    const d = body.data ?? {}
    const live = typeof d.quota_per_unit === 'number' && d.quota_per_unit > 0
    return {
      quotaPerUnit: live ? d.quota_per_unit! : QUOTA_PER_USD,
      quotaPerUnitSource: live ? 'deployment' : fallbackSource,
      version: typeof d.version === 'string' ? d.version : '',
      startTime: typeof d.start_time === 'number' && d.start_time > 0 ? d.start_time : 0,
      systemName: typeof d.system_name === 'string' ? d.system_name : '',
    }
  } catch {
    return {
      quotaPerUnit: QUOTA_PER_USD,
      quotaPerUnitSource: fallbackSource,
      version: '',
      startTime: 0,
      systemName: '',
    }
  }
}

/** Remaining balance in USD, or null for unlimited-quota keys. Pass `perUsd` (from {@link fetchQuotaPerUsd}) for a retuned self-hosted peg; omitted, it uses the published default. */
export async function fetchBalanceUsd(
  opts: RequestOptions,
  perUsd: number = QUOTA_PER_USD
): Promise<number | null> {
  const wallet = await fetchWallet(opts)
  if (wallet.unlimited_quota) return null
  const rate = perUsd > 0 ? perUsd : QUOTA_PER_USD
  return (wallet.total_available ?? 0) / rate
}

// ---------------------------------------------------------------------------
// Pricing. /api/pricing returns raw model/completion ratios; EveryAPI's per-1M-token price is the same math as apps/jetbrains (Gateway.kt fetchPricing): ratio 1 == $2/1M upstream, EveryAPI charges a flat 15%.

const RATE_BASE_PER_1M = 2
const EVERYAPI_DISCOUNT = 0.15

export interface ModelPrice {
  model: string
  /** USD per 1M input tokens. */
  inputPer1M: number
  /** USD per 1M output tokens. */
  outputPer1M: number
}

interface PricingRow {
  model_name?: string
  model_ratio?: number
  completion_ratio?: number
}

/**
 * GET `{admin}/pricing` — public per-model price catalog (USD per 1M tokens).
 *
 * ⚠ Keeps the "non-array `data` → empty catalog" tolerance that {@link fetchLogs} deliberately dropped. Do NOT symmetrize them: the two endpoints build their payload differently. The pricing handler returns its in-memory catalog slice straight through — including when that slice is nil (its group filter short-circuits `len(pricing) == 0` by returning the argument unchanged, and the catalog cache is reset to nil on invalidation) — so `data: null` here IS a legitimate empty catalog, and rejecting it would turn a cold cache into "pricing unavailable". The log endpoint has no such path: gorm allocates the slice before scanning, so its empty case is always `[]`.
 */
export async function fetchPricing(opts: RequestOptions): Promise<ModelPrice[]> {
  const url = `${adminApiBase(opts.baseUrl)}/pricing`
  const body = await getJson<Envelope<PricingRow[]>>(url, opts)
  const err = envelopeError(body, opts.apiKey)
  if (err) throw new Error(err)
  const rows = Array.isArray(body.data) ? body.data : []
  return rows.flatMap((r) => {
    // Drop unpriced models (ratio <= 0): the backend uses ratio 0 as an "unpriced / not sold" sentinel, and rendering it as a real $0.00 model misleads. apps/landingpage/src/lib/public-pricing.ts drops the same rows for
    // the same reason.
    if (!r.model_name || typeof r.model_ratio !== 'number' || r.model_ratio <= 0) return []
    const completionRatio = typeof r.completion_ratio === 'number' ? r.completion_ratio : 1
    return [
      {
        model: r.model_name,
        inputPer1M: r.model_ratio * RATE_BASE_PER_1M * EVERYAPI_DISCOUNT,
        outputPer1M: r.model_ratio * completionRatio * RATE_BASE_PER_1M * EVERYAPI_DISCOUNT,
      },
    ]
  })
}

// ---------------------------------------------------------------------------
// Usage aggregation. The backend ships no per-token rollup, so we synthesize one from the last-N log rows (ported from apps/raycast/src/wallet.tsx).

export interface UsageSummary {
  count: number
  totalQuota: number
  avgQuota: number
  todayQuota: number
  todayCalls: number
  todayPromptTokens: number
  todayCompletionTokens: number
  weekQuota: number
  weekCalls: number
  topModels: Array<{ name: string; count: number; quota: number }>
  biggest: LogRow | null
  /** index 0 = 6 days ago … index 6 = today */
  dailyQuota: number[]
  dailyCalls: number[]
}

export function summarize(logs: LogRow[], now: Date = new Date()): UsageSummary {
  const todayStart = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime() / 1000
  // Bucket boundaries are local calendar midnights, not fixed 86400s steps: a DST week has 23h/25h days, so dividing an epoch delta by a constant would land near-midnight logs in the adjacent day's bucket. index 0 = 6 days ago … index 6 = today.
  const dayStarts = Array.from<number>({ length: 7 })
  for (let i = 0; i < 7; i++) {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - (6 - i))
    dayStarts[i] = d.getTime() / 1000
  }
  const weekStart = dayStarts[0]!

  let totalQuota = 0
  let todayQuota = 0
  let todayCalls = 0
  let todayPromptTokens = 0
  let todayCompletionTokens = 0
  let weekQuota = 0
  let weekCalls = 0
  const modelCount: Record<string, number> = {}
  const modelQuota: Record<string, number> = {}
  let biggest: LogRow | null = null

  const dailyQuota = Array.from<number>({ length: 7 }).fill(0)
  const dailyCalls = Array.from<number>({ length: 7 }).fill(0)

  for (const l of logs) {
    totalQuota += l.quota
    if (l.created_at >= todayStart) {
      todayQuota += l.quota
      todayCalls++
      todayPromptTokens += l.prompt_tokens || 0
      todayCompletionTokens += l.completion_tokens || 0
    }
    if (l.created_at >= weekStart) {
      weekQuota += l.quota
      weekCalls++
      // Assign to the last local-midnight boundary at or before the log.
      let bucket = 0
      for (let i = 6; i >= 0; i--) {
        if (l.created_at >= dayStarts[i]!) {
          bucket = i
          break
        }
      }
      dailyQuota[bucket]! += l.quota
      dailyCalls[bucket]! += 1
    }
    if (l.model_name) {
      modelCount[l.model_name] = (modelCount[l.model_name] || 0) + 1
      modelQuota[l.model_name] = (modelQuota[l.model_name] || 0) + l.quota
    }
    if (!biggest || l.quota > biggest.quota) biggest = l
  }

  const topModels = Object.entries(modelCount)
    .map(([name, count]) => ({ name, count, quota: modelQuota[name] || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  return {
    count: logs.length,
    totalQuota,
    avgQuota: logs.length ? totalQuota / logs.length : 0,
    todayQuota,
    todayCalls,
    todayPromptTokens,
    todayCompletionTokens,
    weekQuota,
    weekCalls,
    topModels,
    biggest,
    dailyQuota,
    dailyCalls,
  }
}
