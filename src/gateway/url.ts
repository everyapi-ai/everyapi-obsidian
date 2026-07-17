// Base-URL math and quota↔USD conversion. Pure, no I/O — the most-reused (and most-tested) corner of the gateway client.

/** Public default gateway. The OpenAI-compatible surface lives under `/v1`. */
export const DEFAULT_BASE_URL = 'https://api.everyapi.ai/v1'

// Quotas are in the gateway's internal unit; default QuotaPerUnit = 500_000 (= $1) per backend/internal/common/constants.go. Self-hosted operators can retune this — pass the deployment's real peg (fetchQuotaPerUsd in account.ts, sourced from /api/status) to fmtUsd so $ figures stay correct; this constant is the fallback when the live value is unknown.
export const QUOTA_PER_USD = 500_000

/** Trim trailing slashes so we never request `.../v1//models`. */
export function normalizeBaseUrl(raw: string | undefined): string {
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

// Account-scoped endpoints (logs, token usage) live under `/api`, not the OpenAI-compatible `/v1`. Derive the admin base by stripping a trailing `/v1` and appending `/api`, so a caller who only set `baseUrl` (or left the default) still hits the right host.
export function adminApiBase(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/, '') + '/api'
}

/**
 * Format an internal quota amount as a USD string. `perUsd` is the deployment's quota→USD peg; it defaults to {@link QUOTA_PER_USD} so existing single-arg callers are unchanged, but a caller that resolved the real rate (via {@link fetchQuotaPerUsd}) should pass it so self-hosted retunes read correctly. A non-positive `perUsd` falls back to the default rather than dividing by zero.
 */
export function fmtUsd(quota: number, perUsd: number = QUOTA_PER_USD): string {
  const rate = perUsd > 0 ? perUsd : QUOTA_PER_USD
  const usd = quota / rate
  if (usd === 0) return '$0'
  const decimals = Math.abs(usd) < 0.01 ? 6 : 4
  return `$${usd.toFixed(decimals).replace(/\.?0+$/, '')}`
}
