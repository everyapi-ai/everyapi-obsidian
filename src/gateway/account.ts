// Account-scoped reads under `/api`: wallet/balance, the usage log, and a
// client-side rollup of that log. All authenticated with the same
// `sk-everyapi-` bearer token (TokenAuthReadOnly on the backend).

import { getJson, type RequestOptions } from './http'
import { adminApiBase, QUOTA_PER_USD } from './url'

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

// The `/api` envelope is `{ code | success, message, data }`. Only an explicit
// boolean `false` is a rejection — a missing flag (or a non-boolean `code`,
// which some envelopes use to carry a numeric status) still means success when
// `data` is present. This matches apps/neovim and apps/raycast; the earlier
// per-surface clients that required `code === true` rejected valid responses.
interface Envelope<T> {
  code?: unknown
  success?: unknown
  message?: string
  data?: T
}

function envelopeError(body: Envelope<unknown>): string | null {
  if (body.code === false || body.success === false) {
    return body.message || 'gateway rejected the request'
  }
  return null
}

/** GET `{admin}/usage/token/` — balance and plan for the presented key. */
export async function fetchWallet(opts: RequestOptions): Promise<WalletData> {
  const url = `${adminApiBase(opts.baseUrl)}/usage/token/`
  const body = await getJson<Envelope<WalletData>>(url, opts)
  const err = envelopeError(body)
  if (err) throw new Error(err)
  if (!body.data) throw new Error(body.message || 'gateway returned no usage data')
  return body.data
}

/** GET `{admin}/log/token` — recent usage rows (≤1000 server-side). */
export async function fetchLogs(opts: RequestOptions): Promise<LogRow[]> {
  const url = `${adminApiBase(opts.baseUrl)}/log/token`
  const body = await getJson<Envelope<LogRow[]>>(url, opts)
  const err = envelopeError(body)
  if (err) throw new Error(err)
  return Array.isArray(body.data) ? body.data : []
}

/**
 * GET `{admin}/status` — the deployment's quota→USD peg (`quota_per_unit`).
 * Self-hosted operators can retune it; the public/default deployment returns
 * {@link QUOTA_PER_USD}. Falls back to that default when the field is
 * absent/non-positive or the request fails, so a caller can always format with
 * the result. Pass it to {@link fmtUsd} (and any `quota / peg` math) instead of
 * the hardcoded constant. The endpoint is public, but we still send auth since
 * every other admin read does.
 */
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

/** Remaining balance in USD, or null for unlimited-quota keys. Pass `perUsd`
 *  (from {@link fetchQuotaPerUsd}) for a retuned self-hosted peg; omitted, it
 *  uses the published default. */
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
// Pricing. /api/pricing returns raw model/completion ratios; EveryAPI's
// per-1M-token price is the same math as apps/landingpage/scripts/gen-pricing
// and apps/jetbrains: ratio 1 == $2/1M upstream, EveryAPI charges a flat 15%.

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

/** GET `{admin}/pricing` — public per-model price catalog (USD per 1M tokens). */
export async function fetchPricing(opts: RequestOptions): Promise<ModelPrice[]> {
  const url = `${adminApiBase(opts.baseUrl)}/pricing`
  const body = await getJson<Envelope<PricingRow[]>>(url, opts)
  const err = envelopeError(body)
  if (err) throw new Error(err)
  const rows = Array.isArray(body.data) ? body.data : []
  return rows.flatMap((r) => {
    if (!r.model_name || typeof r.model_ratio !== 'number') return []
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
// Usage aggregation. The backend ships no per-token rollup, so we synthesize
// one from the last-N log rows (ported from apps/raycast/src/wallet.tsx).

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
  // Bucket boundaries are local calendar midnights, not fixed 86400s steps:
  // a DST week has 23h/25h days, so dividing an epoch delta by a constant
  // would land near-midnight logs in the adjacent day's bucket. index 0 = 6
  // days ago … index 6 = today.
  const dayStarts = new Array(7) as number[]
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

  const dailyQuota = new Array(7).fill(0) as number[]
  const dailyCalls = new Array(7).fill(0) as number[]

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
