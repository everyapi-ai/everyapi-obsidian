// Base-URL math and quota↔USD conversion. Pure, no I/O — the most-reused
// (and most-tested) corner of the gateway client.

/** Public default gateway. The OpenAI-compatible surface lives under `/v1`. */
export const DEFAULT_BASE_URL = 'https://api.everyapi.ai/v1'

// Quotas are in the gateway's internal unit; default QuotaPerUnit = 500_000
// (= $1) per backend/internal/common/constants.go. Self-hosted operators can
// retune this, in which case $ figures derived here are off by that factor —
// the dashboard remains authoritative.
export const QUOTA_PER_USD = 500_000

/** Trim trailing slashes so we never request `.../v1//models`. */
export function normalizeBaseUrl(raw: string | undefined): string {
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

// Account-scoped endpoints (logs, token usage) live under `/api`, not the
// OpenAI-compatible `/v1`. Derive the admin base by stripping a trailing
// `/v1` and appending `/api`, so a caller who only set `baseUrl` (or left the
// default) still hits the right host.
export function adminApiBase(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/, '') + '/api'
}

/** Format an internal quota amount as a USD string at {@link QUOTA_PER_USD}. */
export function fmtUsd(quota: number): string {
  const usd = quota / QUOTA_PER_USD
  if (usd === 0) return '$0'
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(6)}`
  return `$${usd.toFixed(4)}`
}
