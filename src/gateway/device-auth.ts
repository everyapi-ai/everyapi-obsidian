// Device authorization grant (RFC 8628) → relay key, ported straight from the Go CLI: clients/cli/cmd/login.go, clients/sdk/api/device_auth.go, and clients/sdk/api/relaykey.go. The user-facing flow: start a flow, show the user_code + verification_uri, poll until the user confirms in their browser, then exchange the management access_token for the account's newest enabled `sk-everyapi-…` relay key (the access_token alone can't relay).

import { redactSecrets } from './http'
import { adminApiBase } from './url'

export interface DeviceAuthStartResp {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export type DevicePollStatus = 'pending' | 'slow_down' | 'expired' | 'denied' | 'authorized'

export interface DeviceAuthPollResp {
  status: DevicePollStatus
  access_token?: string
  user_id?: number
  username?: string
}

export interface DeviceLoginResult {
  /** The resolved `sk-everyapi-…` relay key, ready to use against `/v1`. */
  apiKey: string
  username?: string
  /** OAuth2 only: the refresh token + access-key expiry (epoch ms) for transparent renewal. Absent on the legacy flow (its keys don't expire). */
  refreshToken?: string
  expiresAt?: number
}

export class DeviceAuthError extends Error {
  constructor(
    readonly kind: 'expired' | 'denied' | 'cancelled' | 'no_key',
    message: string
  ) {
    super(message)
    this.name = 'DeviceAuthError'
  }
}

interface Opts {
  /** OpenAI-compatible base (e.g. https://api.everyapi.ai/v1) — `/api` is derived. */
  baseUrl: string
  userAgent?: string
}

interface Envelope<T> {
  success?: boolean
  code?: unknown
  message?: string
  data?: T
}

function headers(o: Opts, auth?: { token: string; userId: number }): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  if (o.userAgent) h['User-Agent'] = o.userAgent
  if (auth) {
    h.Authorization = `Bearer ${auth.token}`
    h['EveryAPI-User-Id'] = String(auth.userId)
  }
  return h
}

/** A definitive response from the server (non-2xx, or a `success:false` envelope) — as opposed to a transport-level failure. The poll loop surfaces these immediately instead of retrying, mirroring the Go SDK's APIError handling. */
export class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'ApiResponseError'
  }
}

async function unwrap<T>(res: Response, url: string, secret?: string): Promise<T> {
  const text = await res.text().catch(() => '')
  let body: Envelope<T> | undefined
  try {
    body = text ? (JSON.parse(text) as Envelope<T>) : undefined
  } catch {
    /* non-JSON handled below */
  }
  // Server-supplied strings can echo the request's Authorization header (a proxy that reflects headers on a 5xx) or a relay key — scrub them before they reach an Error/log line, matching http.ts/chat.ts/account.ts.
  const redact = (m: string): string => redactSecrets(m, secret)
  if (!res.ok) {
    throw new ApiResponseError(
      redact(body?.message || `HTTP ${res.status} ${res.statusText} from ${url}`),
      res.status
    )
  }
  if (!body) throw new ApiResponseError(`non-JSON response from ${url}`, res.status)
  if (body.success === false) {
    throw new ApiResponseError(redact(body.message || 'request rejected'), res.status)
  }
  if (body.data === undefined)
    throw new ApiResponseError(redact(body.message || 'gateway returned no data'), res.status)
  return body.data
}

async function post<T>(
  url: string,
  h: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
  secret?: string
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: h,
    body: body == null ? undefined : JSON.stringify(body),
    signal: signal ?? null,
  })
  return unwrap<T>(res, url, secret)
}

async function get<T>(
  url: string,
  h: Record<string, string>,
  signal?: AbortSignal,
  secret?: string
): Promise<T> {
  const res = await fetch(url, { headers: h, signal: signal ?? null })
  return unwrap<T>(res, url, secret)
}

/** POST /api/cli/device-auth-start — begin a flow (public, no auth). */
export function deviceAuthStart(o: Opts, signal?: AbortSignal): Promise<DeviceAuthStartResp> {
  return post(`${adminApiBase(o.baseUrl)}/cli/device-auth-start`, headers(o), null, signal)
}

/** POST /api/cli/device-auth-poll — one poll (public, no auth). */
export function deviceAuthPoll(
  o: Opts,
  deviceCode: string,
  signal?: AbortSignal
): Promise<DeviceAuthPollResp> {
  return post(
    `${adminApiBase(o.baseUrl)}/cli/device-auth-poll`,
    headers(o),
    { device_code: deviceCode },
    signal
  )
}

const TOKEN_STATUS_ENABLED = 1

interface TokenSummary {
  id: number
  name: string
  status: number
  group: string
}

/** Exchange a management access_token for the account's newest enabled relay key. Mirrors api.ResolveRelayKey: list tokens (GET /api/token/), pick the first enabled one, fetch its plaintext key (POST /api/token/{id}/key). */
export async function resolveRelayKey(
  o: Opts,
  accessToken: string,
  userId: number,
  signal?: AbortSignal
): Promise<string> {
  const auth = { token: accessToken, userId }
  const list = await get<{ items?: TokenSummary[] }>(
    `${adminApiBase(o.baseUrl)}/token/`,
    headers(o, auth),
    signal,
    accessToken
  )
  const pick = (list.items ?? []).find((t) => t.status === TOKEN_STATUS_ENABLED)
  if (!pick) {
    throw new DeviceAuthError(
      'no_key',
      'No enabled API key on the account — create one at https://app.everyapi.ai.'
    )
  }
  const keyResp = await post<{ key?: string }>(
    `${adminApiBase(o.baseUrl)}/token/${pick.id}/key`,
    headers(o, auth),
    null,
    signal,
    accessToken
  )
  if (!keyResp.key) throw new DeviceAuthError('no_key', 'The gateway returned an empty key.')
  return keyResp.key
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = () => {
      clearTimeout(t)
      resolve()
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// --- New OAuth 2.0 device grant (/api/oauth2/*) ---

const OAUTH_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

const oauthBase = (baseUrl: string): string => `${adminApiBase(baseUrl)}/oauth2`

/** Thrown when the gateway has no /api/oauth2 routes (older deployment), so the caller falls back to the legacy /api/cli/device-auth-* flow. */
class OAuthEndpointMissing extends Error {}

interface OAuthFormResult<T> {
  status: number
  data: Partial<T> & { error?: string; error_description?: string }
}

async function oauthForm<T>(
  url: string,
  body: Record<string, string>,
  userAgent: string | undefined,
  signal: AbortSignal
): Promise<OAuthFormResult<T>> {
  const h: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (userAgent) h['User-Agent'] = userAgent
  const res = await fetch(url, {
    method: 'POST',
    headers: h,
    body: new URLSearchParams(body).toString(),
    signal,
  })
  let data: OAuthFormResult<T>['data'] = {}
  try {
    // JSON.parse('null') / '123' / '"x"' parse successfully but aren't objects; adopting one would make callers' `data.error` throw a TypeError. Only take a parsed object, so a `null`/primitive body falls back to the empty {}.
    const parsed: unknown = JSON.parse(await res.text())
    if (parsed && typeof parsed === 'object') data = parsed as OAuthFormResult<T>['data']
  } catch {
    /* non-JSON (e.g. a 404 HTML page) — resolved via status below */
  }
  return { status: res.status, data }
}

interface OAuthDeviceStart extends DeviceAuthStartResp {
  verification_uri_complete?: string
}

/** OAuth 2.0 Device Authorization Grant (RFC 8628) against /api/oauth2/*. The issued access_token IS the relay key (sk-everyapi-…), so there's no separate relay-key resolution. Throws OAuthEndpointMissing when the routes are absent. */
async function loginWithOAuth2Device(opts: {
  baseUrl: string
  userAgent?: string
  signal: AbortSignal
  clientId: string
  onPrompt: (start: DeviceAuthStartResp) => void
}): Promise<DeviceLoginResult> {
  const base = oauthBase(opts.baseUrl)
  const begin = await oauthForm<OAuthDeviceStart>(
    `${base}/device`,
    { client_id: opts.clientId, scope: 'api' },
    opts.userAgent,
    opts.signal
  )
  // Fall back to legacy when the routes are absent (404) or the client isn't recognized (invalid_client / unauthorized_client). A transient non-2xx (5xx) is a real error — don't mis-read its empty body as "unavailable" and silently downgrade.
  if (
    begin.status === 404 ||
    begin.data.error === 'invalid_client' ||
    begin.data.error === 'unauthorized_client'
  ) {
    throw new OAuthEndpointMissing()
  }
  if (begin.data.error)
    throw new ApiResponseError(
      // The device-start request carries no secret (client_id is a public OAuth client identifier), so only the sk-everyapi- format regex applies — don't scrub the client_id, which a developer needs to diagnose a client-registration failure.
      redactSecrets(begin.data.error_description || begin.data.error),
      begin.status
    )
  if (begin.status < 200 || begin.status >= 300) {
    throw new ApiResponseError(`oauth2 device: HTTP ${begin.status}`, begin.status)
  }
  const start = begin.data
  if (!start.device_code || !start.user_code) throw new OAuthEndpointMissing()
  opts.onPrompt({
    device_code: start.device_code,
    user_code: start.user_code,
    verification_uri: start.verification_uri_complete || start.verification_uri || '',
    expires_in: start.expires_in ?? 600,
    interval: start.interval ?? 5,
  })

  let intervalMs = Math.max(1, start.interval || 5) * 1000
  const deadline = Date.now() + Math.max(60, start.expires_in || 600) * 1000
  let transientFails = 0
  for (;;) {
    if (opts.signal.aborted) throw new DeviceAuthError('cancelled', 'Sign-in cancelled.')
    await sleep(intervalMs, opts.signal)
    if (opts.signal.aborted) throw new DeviceAuthError('cancelled', 'Sign-in cancelled.')
    if (Date.now() > deadline) {
      throw new DeviceAuthError('expired', 'The code expired before you authorized — try again.')
    }
    let poll: OAuthFormResult<{ access_token: string; refresh_token?: string; expires_in?: number }>
    try {
      poll = await oauthForm<{ access_token: string; refresh_token?: string; expires_in?: number }>(
        `${base}/token`,
        {
          grant_type: OAUTH_DEVICE_GRANT,
          device_code: start.device_code,
          client_id: opts.clientId,
        },
        opts.userAgent,
        opts.signal
      )
    } catch (e) {
      // The user is mid-browser; a transport blip shouldn't kill sign-in.
      if (opts.signal.aborted) throw new DeviceAuthError('cancelled', 'Sign-in cancelled.')
      if (++transientFails > 3) throw e
      continue
    }
    const err = poll.data.error
    if (err === 'authorization_pending') {
      transientFails = 0
      continue
    }
    if (err === 'slow_down') {
      transientFails = 0
      intervalMs += 5000
      continue
    }
    if (err === 'expired_token')
      throw new DeviceAuthError('expired', 'The code expired before you authorized — try again.')
    if (err === 'access_denied')
      throw new DeviceAuthError('denied', 'Authorization was denied in the browser.')
    if (err)
      throw new ApiResponseError(
        redactSecrets(poll.data.error_description || err, start.device_code),
        poll.status
      )
    if (poll.data.access_token) {
      return {
        apiKey: poll.data.access_token,
        refreshToken: poll.data.refresh_token,
        expiresAt: poll.data.expires_in ? Date.now() + poll.data.expires_in * 1000 : undefined,
      }
    }
    // No recognized OAuth error field and no token. A 2xx here is a spec-legal keep-polling. But a non-2xx with an empty/non-JSON body (a proxy 502, a backend restart) carries no `error`, so it would otherwise fall through and loop silently until the deadline — then mis-report "code expired" even though the user authorized. Count it against the same transient budget the thrown-fetch path uses, and surface the real cause once spent.
    if (poll.status >= 200 && poll.status < 300) {
      transientFails = 0
      continue
    }
    if (++transientFails > 3) {
      throw new ApiResponseError(`oauth2 token poll failed: HTTP ${poll.status}`, poll.status)
    }
  }
}

/** Refresh an OAuth2 device-issued key (grant_type=refresh_token). Returns the new key + rotated refresh token + new expiry. Throws on failure — the caller keeps the old key and/or prompts a fresh sign-in. Only the OAuth2 flow issues refresh tokens; legacy keys never call this. */
export async function refreshDeviceToken(opts: {
  baseUrl: string
  userAgent?: string
  clientId: string
  refreshToken: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<DeviceLoginResult> {
  const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 15000)
  const r = await oauthForm<{ access_token: string; refresh_token?: string; expires_in?: number }>(
    `${oauthBase(opts.baseUrl)}/token`,
    { grant_type: 'refresh_token', refresh_token: opts.refreshToken, client_id: opts.clientId },
    opts.userAgent,
    signal
  )
  if (r.data.error || !r.data.access_token) {
    throw new ApiResponseError(
      // Thread the live refresh_token so a proxy that reflects the request body into error_description cannot leak it (it isn't sk-everyapi-shaped, so the format regex alone would miss it), matching every other error path.
      redactSecrets(
        r.data.error_description || r.data.error || 'refresh failed',
        opts.refreshToken
      ),
      r.status
    )
  }
  return {
    apiKey: r.data.access_token,
    refreshToken: r.data.refresh_token,
    expiresAt: r.data.expires_in ? Date.now() + r.data.expires_in * 1000 : undefined,
  }
}

/** Full legacy device-auth login → relay key. Ported from cmd/login.go + device_auth.go's PollUntilDone: adaptive interval, slow_down backoff, a small transient-error budget, and the same terminal states. */
async function loginWithLegacyDeviceAuth(opts: {
  baseUrl: string
  userAgent?: string
  signal: AbortSignal
  /** Called once with the code + URL the user must visit. */
  onPrompt: (start: DeviceAuthStartResp) => void
}): Promise<DeviceLoginResult> {
  const o: Opts = { baseUrl: opts.baseUrl, userAgent: opts.userAgent }
  const start = await deviceAuthStart(o, opts.signal)
  opts.onPrompt(start)

  let intervalMs = Math.max(1, start.interval || 5) * 1000
  const deadline = Date.now() + Math.max(60, start.expires_in || 600) * 1000
  let transientFails = 0

  for (;;) {
    if (opts.signal.aborted) throw new DeviceAuthError('cancelled', 'Sign-in cancelled.')
    await sleep(intervalMs, opts.signal)
    if (opts.signal.aborted) throw new DeviceAuthError('cancelled', 'Sign-in cancelled.')
    if (Date.now() > deadline) {
      throw new DeviceAuthError('expired', 'The code expired before you authorized — try again.')
    }

    let poll: DeviceAuthPollResp
    try {
      poll = await deviceAuthPoll(o, start.device_code, opts.signal)
    } catch (err) {
      if (opts.signal.aborted) throw new DeviceAuthError('cancelled', 'Sign-in cancelled.')
      // A definitive server response (4xx/5xx, success:false) is final — surface it now. Only transport-level failures (the user mid-browser, a network blip) are retried against a small budget.
      if (err instanceof ApiResponseError) throw err
      if (++transientFails > 3) throw err
      continue
    }
    transientFails = 0

    switch (poll.status) {
      case 'authorized': {
        if (!poll.access_token || poll.user_id == null) {
          throw new Error('authorized but the gateway returned no token')
        }
        const apiKey = await resolveRelayKey(o, poll.access_token, poll.user_id, opts.signal)
        return { apiKey, username: poll.username }
      }
      case 'expired':
        throw new DeviceAuthError('expired', 'The code expired before you authorized — try again.')
      case 'denied':
        throw new DeviceAuthError('denied', 'Authorization was denied in the browser.')
      case 'slow_down':
        intervalMs += 5000
        break
      case 'pending':
        break
    }
  }
}

/** Device-auth login that supports BOTH backends: the OAuth 2.0 device grant (/api/oauth2/*, tried first when `clientId` is given) and the legacy /api/cli/device-auth-* flow (used when the gateway has no oauth2 routes). A client therefore works against old and new deployments alike. */
export async function loginWithDeviceAuth(opts: {
  baseUrl: string
  userAgent?: string
  signal: AbortSignal
  /** Called once with the code + URL the user must visit. */
  onPrompt: (start: DeviceAuthStartResp) => void
  /** OAuth2 client id (e.g. "everyapi-vscode"). Omit to use only the legacy flow. */
  clientId?: string
}): Promise<DeviceLoginResult> {
  if (opts.clientId) {
    try {
      return await loginWithOAuth2Device({ ...opts, clientId: opts.clientId })
    } catch (err) {
      // Only a missing-endpoint signal falls through to legacy; real errors (denied, expired, network) surface to the caller.
      if (!(err instanceof OAuthEndpointMissing)) throw err
    }
  }
  return loginWithLegacyDeviceAuth(opts)
}
