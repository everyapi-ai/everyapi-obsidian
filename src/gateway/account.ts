// Account-scoped reads under `/api`: wallet/balance, the usage log, and a client-side rollup of that log. All authenticated with the same `sk-everyapi-` bearer token (TokenAuthReadOnly on the backend).

import { getJson, redactSecrets, type RequestOptions } from './http'
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

/** GET `{admin}/log/token` — recent usage rows (≤1000 server-side). */
export async function fetchLogs(opts: RequestOptions): Promise<LogRow[]> {
  const url = `${adminApiBase(opts.baseUrl)}/log/token`
  const body = await getJson<Envelope<LogRow[]>>(url, opts)
  const err = envelopeError(body, opts.apiKey)
  if (err) throw new Error(err)
  return Array.isArray(body.data) ? body.data : []
}

/** GET `{admin}/status` — the deployment's quota→USD peg (`quota_per_unit`). Self-hosted operators can retune it; the public/default deployment returns {@link QUOTA_PER_USD}. Falls back to that default when the field is absent/non-positive or the request fails, so a caller can always format with the result. Pass it to {@link fmtUsd} (and any `quota / peg` math) instead of the hardcoded constant. The endpoint is public, but we still send auth since every other admin read does. */
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

export interface StatusInfo {
  /** quota→USD peg; falls back to {@link QUOTA_PER_USD}. */
  quotaPerUnit: number
  /** Deployment build version ('' when the field is absent). */
  version: string
  /** Process start time, unix seconds (0 when absent) — derive uptime from it. */
  startTime: number
  /** Operator-set deployment name ('' when absent). */
  systemName: string
}

/** GET `{admin}/status` — deployment identity + the quota→USD peg in one read. A richer sibling of {@link fetchQuotaPerUsd} for callers that also want to show which deployment/version a key is hitting (e.g. a status tooltip). The endpoint is public; we send auth like every other admin read. Never throws — every field falls back so a caller can always render. */
export async function fetchStatus(opts: RequestOptions): Promise<StatusInfo> {
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
    return {
      quotaPerUnit:
        typeof d.quota_per_unit === 'number' && d.quota_per_unit > 0
          ? d.quota_per_unit
          : QUOTA_PER_USD,
      version: typeof d.version === 'string' ? d.version : '',
      startTime: typeof d.start_time === 'number' && d.start_time > 0 ? d.start_time : 0,
      systemName: typeof d.system_name === 'string' ? d.system_name : '',
    }
  } catch {
    return { quotaPerUnit: QUOTA_PER_USD, version: '', startTime: 0, systemName: '' }
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
// Pricing. `/api/pricing` returns raw model/completion ratios plus the `group_ratio` map for the route groups the caller may use, and the price per 1M tokens is `model_ratio * 2 * group_ratio` — the same convention the dashboard pricing page renders and settlement charges (backend/internal/relay/helper/price.go multiplies the model quota by the routed group's ratio). This client cannot know which pool a given key will route through, so it quotes the cheapest ratio among the groups the model is enabled in, matching packages/api's documented derivation and the dashboard's WebMCP model projection.
//
// This used to multiply by a hardcoded 0.15 "EveryAPI discount", which is only the hosted deployment's default group ratio: against a self-hosted deployment (shipped default group ratio 1) or any group with a different ratio, every quote was off by ratio/0.15.

const RATE_BASE_PER_1M = 2

/** `enable_groups` sentinel — the model is sold in every route group. */
const ENABLE_GROUP_ALL = 'all'

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
  enable_groups?: string[]
}

/** `/api/pricing` carries `group_ratio` as a sibling of `data`, not inside it. */
interface PricingEnvelope extends Envelope<PricingRow[]> {
  group_ratio?: Record<string, number>
}

/** Cheapest route-group multiplier this row can bill at. Falls back to 1 (list price, what a stock deployment charges) when the server sends no usable ratio — never to a discount the deployment may not grant. */
function cheapestGroupRatio(
  row: PricingRow,
  groupRatio: Record<string, number> | undefined
): number {
  const groups = Object.entries(groupRatio ?? {}).filter(
    ([, ratio]) => typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0
  )
  const enabled = Array.isArray(row.enable_groups) ? row.enable_groups : []
  const applicable = enabled.includes(ENABLE_GROUP_ALL)
    ? groups
    : groups.filter(([group]) => enabled.includes(group))
  if (applicable.length === 0) return 1
  return Math.min(...applicable.map(([, ratio]) => ratio))
}

/** GET `{admin}/pricing` — public per-model price catalog (USD per 1M tokens). */
export async function fetchPricing(opts: RequestOptions): Promise<ModelPrice[]> {
  const url = `${adminApiBase(opts.baseUrl)}/pricing`
  const body = await getJson<PricingEnvelope>(url, opts)
  const err = envelopeError(body, opts.apiKey)
  if (err) throw new Error(err)
  const rows = Array.isArray(body.data) ? body.data : []
  return rows.flatMap((r) => {
    // Drop unpriced models (ratio <= 0): the backend uses ratio 0 as an "unpriced / not sold" sentinel, and rendering it as a real $0.00 model misleads. Matches apps/landingpage/scripts/gen-pricing.mjs, which skips
    // ratio <= 0.
    if (!r.model_name || typeof r.model_ratio !== 'number' || r.model_ratio <= 0) return []
    const completionRatio = typeof r.completion_ratio === 'number' ? r.completion_ratio : 1
    const groupRatio = cheapestGroupRatio(r, body.group_ratio)
    const inputPer1M = r.model_ratio * RATE_BASE_PER_1M * groupRatio
    return [
      {
        model: r.model_name,
        inputPer1M,
        outputPer1M: inputPer1M * completionRatio,
      },
    ]
  })
}

// ---------------------------------------------------------------------------
// Usage aggregation, TOKEN-scoped and bucketed on the CLIENT's local calendar. Synthesized from the last-N `/api/log/token` rows (ported from apps/raycast/src/wallet.tsx), which the backend caps at 1000 — so on a busy key these figures under-report. It is the right source for a per-key view, for the 7-day series and `biggest` (which no server endpoint provides), and as the fallback for a deployment without `/api/usage/account`; for account-wide today/7-day/top-model totals prefer `fetchAccountSummary` above.

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

// ---------------------------------------------------------------------------
// Server-computed account rollup. `/api/usage/account` (backend: transport/http/token/raycast_account.go → modules/account.GetRaycastUsageSummary) aggregates the whole log table in SQL, so it is correct on an account with more than the 1000 rows `/api/log/token` will ever return. Same auth gate as the other reads here: TokenAuthReadOnly, which accepts any enabled, unexpired `sk-everyapi-` key whose scope set is empty or contains `usage:read`.

export interface AccountUsagePeriod {
  requests: number
  quota: number
  prompt_tokens: number
  completion_tokens: number
}

export interface AccountTopModel {
  model: string
  requests: number
  quota: number
}

export interface AccountUsage {
  today: AccountUsagePeriod
  last_7_days: AccountUsagePeriod
  /** Up to five models, ordered by request count descending, over the same 7-day window as {@link last_7_days}. */
  top_models: AccountTopModel[]
  /** The timezone the day boundaries were computed in. The backend pins this to `UTC` so every API replica agrees; a client rendering "today" in local time will disagree with it near midnight. */
  timezone: string
}

export interface AccountSummary {
  username: string
  display_name: string
  avatar_url: string
  /** The OWNER's wallet, in the same internal quota unit as {@link WalletData.total_available}; divide by the deployment's peg ({@link fetchQuotaPerUsd}). Distinct from a per-key balance: `/api/usage/token/` reports what THIS key may still spend, this reports what the account holds. */
  wallet: { quota: number; currency: string }
  /** Unix seconds at which the presented key expires; `-1` for a key that never expires. */
  oauth_token: { expires_at: number }
  usage: AccountUsage
}

const EMPTY_PERIOD: AccountUsagePeriod = {
  requests: 0,
  quota: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
}

function usagePeriod(raw: Partial<AccountUsagePeriod> | undefined): AccountUsagePeriod {
  if (!raw) return { ...EMPTY_PERIOD }
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    requests: num(raw.requests),
    quota: num(raw.quota),
    prompt_tokens: num(raw.prompt_tokens),
    completion_tokens: num(raw.completion_tokens),
  }
}

/**
 * GET `{admin}/usage/account` — the server-computed today / last-7-days / top-5-models rollup for the key OWNER.
 *
 * Prefer this over `fetchLogs` + {@link summarize} wherever both work: the rollup is a SQL aggregate over the whole log table, while `/api/log/token` is capped at 1000 rows, so on a busy account the local recomputation silently under-reports and every client under-reports differently.
 *
 * Two semantic differences a caller must not paper over:
 *
 *  - SCOPE. This aggregates every request the OWNER made, across all their keys. {@link fetchLogs}/{@link summarize} aggregate only the presented key's rows. A surface labelled "this key's usage" wants the log path; one labelled "your usage" wants this.
 *  - DAY BOUNDARIES. The backend buckets on UTC midnights and names the timezone in {@link AccountUsage.timezone}; {@link summarize} buckets on the client's LOCAL calendar midnights. The two "today" figures legitimately differ for a user who is not on UTC.
 *
 * Throws on a non-2xx (404 on a deployment predating the endpoint, 403 for a key whose explicit scope set omits `usage:read`) and on an envelope-level failure. {@link fetchUsageOverview} wraps that with the log fallback.
 */
export async function fetchAccountSummary(opts: RequestOptions): Promise<AccountSummary> {
  const url = `${adminApiBase(opts.baseUrl)}/usage/account`
  const body = await getJson<Envelope<AccountSummary>>(url, opts)
  const err = envelopeError(body, opts.apiKey)
  if (err) throw new Error(err)
  const data = body.data
  if (!data)
    throw new Error(redactSecrets(body.message || 'gateway returned no account data', opts.apiKey))
  const usage = data.usage
  return {
    username: typeof data.username === 'string' ? data.username : '',
    display_name: typeof data.display_name === 'string' ? data.display_name : '',
    avatar_url: typeof data.avatar_url === 'string' ? data.avatar_url : '',
    wallet: {
      quota: typeof data.wallet?.quota === 'number' ? data.wallet.quota : 0,
      currency: typeof data.wallet?.currency === 'string' ? data.wallet.currency : 'USD',
    },
    // -1 is the backend's "never expires" sentinel, so it must survive rather than be normalized to 0 (which a caller would read as "expired at the epoch").
    oauth_token: {
      expires_at:
        typeof data.oauth_token?.expires_at === 'number' ? data.oauth_token.expires_at : -1,
    },
    usage: {
      today: usagePeriod(usage?.today),
      last_7_days: usagePeriod(usage?.last_7_days),
      top_models: Array.isArray(usage?.top_models)
        ? usage.top_models.filter((m) => m && typeof m.model === 'string')
        : [],
      timezone: typeof usage?.timezone === 'string' ? usage.timezone : 'UTC',
    },
  }
}

/** Where a {@link UsageOverview}'s numbers came from — the two sources cover different scopes and different day boundaries, so a UI that can show both should say which it has. */
export type UsageOverviewSource = 'account-rollup' | 'token-logs'

/**
 * The figures BOTH usage sources can state honestly, so a caller can render one component against either.
 *
 * Deliberately the intersection, not the union: the rollup has no per-day series and no single largest call, and zero-filling those from a source that does not have them would render an empty sparkline as real data. A surface that needs the 7-day series or `biggest` must call {@link fetchLogs} + {@link summarize} itself and accept the 1000-row cap.
 */
export interface UsageOverview {
  source: UsageOverviewSource
  /** `'UTC'` for the rollup; `'local'` when computed client-side from the log rows. */
  timezone: string
  /** True when the numbers cover every key the owner holds (the rollup) rather than only the presented key (the logs). */
  accountWide: boolean
  todayQuota: number
  todayCalls: number
  todayPromptTokens: number
  todayCompletionTokens: number
  weekQuota: number
  weekCalls: number
  topModels: Array<{ name: string; count: number; quota: number }>
}

/**
 * Usage figures from the server rollup, falling back to the client-side recomputation when the rollup is unreachable.
 *
 * The fallback is for a deployment that does not serve `/api/usage/account` (self-hosted builds predating it answer 404) or a key that may not reach it (403 when its explicit scope set omits `usage:read` — though such a key cannot read `/api/log/token` either, so that path then fails too and this rethrows). Any rollup failure falls through; the log error is what surfaces if the fallback also fails.
 *
 * Read {@link UsageOverview.source} before comparing numbers across sessions: the two paths differ in scope and in day boundaries, so a value can legitimately change when the source does.
 */
export async function fetchUsageOverview(opts: RequestOptions): Promise<UsageOverview> {
  try {
    const summary = await fetchAccountSummary(opts)
    const { today, last_7_days, top_models, timezone } = summary.usage
    return {
      source: 'account-rollup',
      timezone,
      accountWide: true,
      todayQuota: today.quota,
      todayCalls: today.requests,
      todayPromptTokens: today.prompt_tokens,
      todayCompletionTokens: today.completion_tokens,
      weekQuota: last_7_days.quota,
      weekCalls: last_7_days.requests,
      topModels: top_models.map((m) => ({ name: m.model, count: m.requests, quota: m.quota })),
    }
  } catch {
    const local = summarize(await fetchLogs(opts))
    return {
      source: 'token-logs',
      timezone: 'local',
      accountWide: false,
      todayQuota: local.todayQuota,
      todayCalls: local.todayCalls,
      todayPromptTokens: local.todayPromptTokens,
      todayCompletionTokens: local.todayCompletionTokens,
      weekQuota: local.weekQuota,
      weekCalls: local.weekCalls,
      topModels: local.topModels,
    }
  }
}
