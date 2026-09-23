// Browser sign-in for the Obsidian panel: the RFC 8628 device authorization grant against the gateway's /api/oauth2 routes, under the first-party client id `everyapi-obsidian`. It replaces "create a key in the console, copy it, paste it here" with "click, approve in your browser, done", and the key it returns renews itself.
//
// Two constraints shape this file. The plugin ships `isDesktopOnly: false`, so it also runs on iOS and Android where there is no Node runtime, no child process and no way to bind a loopback socket — which is exactly why the backend registers this client with NO redirect URI and device-grant-only: an authorization-code callback would work on desktop and fail silently on a phone. And the mobile in-app browser can swallow a query parameter, so the user code is always rendered with a copy button even when we open `verification_uri_complete` for them.
//
// The shared client (@everyapi-ai/gateway loginWithDeviceAuth) owns the protocol: it tries /api/oauth2 first and falls back to the legacy /api/cli/device-auth-* flow only when the routes are absent or the client id is unknown, which is what keeps this working against a gateway that predates the OAuth2 endpoints. Pasting a key by hand stays fully supported — see EveryApiSettings.apiKey, which a manual key still fills in with no refresh token beside it.

import {
  adminApiBase,
  DeviceAuthError,
  loginWithDeviceAuth,
  refreshDeviceToken,
} from '@everyapi-ai/gateway'
import { App, Modal, Notice, Platform } from 'obsidian'

import { OAUTH_CLIENT_ID } from './constants'
import { t } from './i18n'
import type EveryApiPlugin from './main'

/** Renew the stored key this long before it expires. The gateway issues 90-day access keys; a week of slack means a user who opens their vault once a week never sees an expired-key error, and a rotation that fails still leaves a working key behind. */
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** True when the plugin holds a device-grant session (as opposed to a manually pasted key, which has no refresh token and never renews). */
export function isDeviceSession(plugin: EveryApiPlugin): boolean {
  return Boolean(plugin.settings.apiKey && plugin.settings.refreshToken)
}

/**
 * Rotate the stored key when it is inside {@link REFRESH_WINDOW_MS} of expiry. Returns true when the credentials changed.
 *
 * Refresh-token rotation is mandatory and enforced server-side: the response carries a NEW refresh token, the old one is revoked, and replaying a used refresh token is treated as theft and revokes the whole family — signing the user out of the plugin entirely. So the new access key and the new refresh token are persisted in a single saveSettings call; there is deliberately no window in which one is stored without the other.
 *
 * Never throws. A failed refresh leaves the existing key in place: it is still valid until its own expiry, and a transport blip must not log the user out.
 */
export async function refreshIfNeeded(plugin: EveryApiPlugin): Promise<boolean> {
  const s = plugin.settings
  if (!s.refreshToken || !s.tokenExpiresAt) return false
  if (Date.now() < s.tokenExpiresAt - REFRESH_WINDOW_MS) return false
  try {
    const result = await refreshDeviceToken({
      baseUrl: s.baseUrl,
      clientId: OAUTH_CLIENT_ID,
      refreshToken: s.refreshToken,
    })
    s.apiKey = result.apiKey
    s.refreshToken = result.refreshToken ?? ''
    s.tokenExpiresAt = result.expiresAt ?? 0
    await plugin.saveSettings()
    return true
  } catch {
    return false
  }
}

/** Drop the device session. The stored key is forgotten locally either way; revoking it server-side is best-effort, because a user who is offline must still be able to sign out of their own vault. */
export async function signOut(plugin: EveryApiPlugin): Promise<void> {
  const s = plugin.settings
  const refreshToken = s.refreshToken
  const baseUrl = s.baseUrl
  s.apiKey = ''
  s.refreshToken = ''
  s.tokenExpiresAt = 0
  await plugin.saveSettings()
  if (refreshToken) void revokeQuietly(baseUrl, refreshToken)
  plugin.onConnectionChanged()
}

async function revokeQuietly(baseUrl: string, refreshToken: string): Promise<void> {
  try {
    await fetch(`${adminApiBase(baseUrl)}/oauth2/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, token: refreshToken }).toString(),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
  } catch {
    // Sign-out is local-first; a gateway that cannot be reached does not keep the user signed in.
  }
}

/** Open the sign-in modal. Resolves true once credentials were stored, false if the user cancelled or the flow failed (the modal reports the reason itself). */
export function startDeviceSignIn(app: App, plugin: EveryApiPlugin): Promise<boolean> {
  return new Promise((resolve) => {
    new DeviceSignInModal(app, plugin, resolve).open()
  })
}

class DeviceSignInModal extends Modal {
  private readonly controller = new AbortController()
  private settled = false
  private statusEl: HTMLElement | null = null
  private codeEl: HTMLElement | null = null
  private actionsEl: HTMLElement | null = null

  constructor(
    app: App,
    private readonly plugin: EveryApiPlugin,
    private readonly resolve: (connected: boolean) => void
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl, titleEl } = this
    titleEl.setText(t('auth.title'))
    contentEl.addClass('everyapi-auth')
    contentEl.createDiv({ cls: 'everyapi-auth-hint', text: t('auth.instructions') })
    this.codeEl = contentEl.createDiv({ cls: 'everyapi-auth-code' })
    this.actionsEl = contentEl.createDiv({ cls: 'everyapi-auth-actions' })
    this.statusEl = contentEl.createDiv({ cls: 'everyapi-auth-status', text: t('auth.starting') })

    const cancel = contentEl
      .createDiv({ cls: 'everyapi-approval-actions' })
      .createEl('button', { text: t('auth.cancel') })
    cancel.addEventListener('click', () => this.close())

    void this.run()
  }

  private async run(): Promise<void> {
    try {
      const result = await loginWithDeviceAuth({
        baseUrl: this.plugin.settings.baseUrl,
        signal: this.controller.signal,
        clientId: OAUTH_CLIENT_ID,
        onPrompt: (start) => this.showPrompt(start.user_code, start.verification_uri),
      })
      const s = this.plugin.settings
      s.apiKey = result.apiKey
      s.refreshToken = result.refreshToken ?? ''
      s.tokenExpiresAt = result.expiresAt ?? 0
      await this.plugin.saveSettings()
      this.settle(true)
      new Notice(t('notice.signedIn'))
      this.close()
      this.plugin.onConnectionChanged()
    } catch (e) {
      if (this.controller.signal.aborted) return
      const reason = e instanceof DeviceAuthError || e instanceof Error ? e.message : String(e)
      this.statusEl?.setText(t('auth.failed', { error: reason }))
      this.statusEl?.addClass('is-error')
    }
  }

  private showPrompt(userCode: string, verificationUri: string): void {
    const code = this.codeEl
    const actions = this.actionsEl
    if (!code || !actions) return
    code.setText(userCode)
    actions.empty()

    // Render the code even when we open the browser ourselves: the dashboard prefills from the query parameter, but the user still has to confirm, and Obsidian's in-app browser on mobile may drop the parameter entirely.
    const copy = actions.createEl('button', { text: t('auth.copyCode') })
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(userCode).then(
        () => new Notice(t('notice.codeCopied')),
        () => undefined
      )
    })

    if (verificationUri) {
      const open = actions.createEl('button', { text: t('auth.openPage'), cls: 'mod-cta' })
      open.addEventListener('click', () => this.openVerification(verificationUri))
      this.contentEl.createDiv({ cls: 'everyapi-auth-url', text: verificationUri })
      // Desktop opens the system browser straight away; on mobile the in-app browser steals focus from the modal the user still needs, so there it stays an explicit tap.
      if (!Platform.isMobile) this.openVerification(verificationUri)
    }

    this.statusEl?.setText(t('auth.waiting'))
  }

  private openVerification(url: string): void {
    window.open(url, '_blank')
  }

  private settle(connected: boolean): void {
    if (this.settled) return
    this.settled = true
    this.resolve(connected)
  }

  onClose(): void {
    this.controller.abort()
    this.contentEl.empty()
    // Dismissed without connecting → report the flow as unfinished so the caller re-renders whatever it had.
    this.settle(false)
  }
}
