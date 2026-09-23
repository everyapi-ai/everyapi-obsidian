import {
  fetchModels,
  filterChatModels,
  resolveChatModel,
  type GatewayModel,
} from '@everyapi-ai/gateway'
import { App, PluginSettingTab, Setting, debounce } from 'obsidian'

import { isDeviceSession, signOut, startDeviceSignIn } from './auth'
import { CLIENT_APP } from './constants'
import { getLocale, t } from './i18n'
import type EveryApiPlugin from './main'

export interface EveryApiSettings {
  apiKey: string
  baseUrl: string
  // Model id used for new chats. Left empty by default — the view resolves it at runtime from /v1/models so we don't ship a hardcoded version number that ages out (same reasoning as apps/raycast).
  defaultModel: string
  // OAuth2 device-grant session, written together with apiKey by src/auth.ts. Empty for a manually pasted key, which is still fully supported and simply never refreshes. Rotation is mandatory server-side, so these two are always saved in the same call as the key they belong to.
  refreshToken: string
  /** Epoch ms at which `apiKey` stops working; 0 when unknown (a pasted key). */
  tokenExpiresAt: number
}

export const DEFAULT_SETTINGS: EveryApiSettings = {
  apiKey: '',
  baseUrl: 'https://api.everyapi.ai/v1',
  defaultModel: '',
  refreshToken: '',
  tokenExpiresAt: 0,
}

export class EveryApiSettingTab extends PluginSettingTab {
  plugin: EveryApiPlugin
  // Settings save on every keystroke; the expensive follow-ups (re-render open panels, re-fetch the status-bar balance) are debounced so typing a key doesn't fire a request per character.
  private notifyChanged = debounce(() => this.plugin.onConnectionChanged(), 800, true)

  constructor(app: App, plugin: EveryApiPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    this.renderAccountSetting(containerEl)

    new Setting(containerEl)
      .setName(t('settings.apiKey'))
      .setDesc(t('settings.apiKeyDescription'))
      .addText((text) => {
        text.inputEl.type = 'password'
        text.inputEl.addClass('everyapi-key-input')
        text
          .setPlaceholder('sk-everyapi-…')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim()
            await this.plugin.saveSettings()
            this.notifyChanged()
          })
      })

    new Setting(containerEl)
      .setName(t('settings.gatewayBaseUrl'))
      .setDesc(t('settings.gatewayBaseUrlDescription'))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.baseUrl)
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            // Trim trailing slash so we don't POST to .../v1//chat/completions.
            this.plugin.settings.baseUrl =
              value.trim().replace(/\/$/, '') || DEFAULT_SETTINGS.baseUrl
            await this.plugin.saveSettings()
            this.notifyChanged()
          })
      )

    void this.renderModelSetting(containerEl)
  }

  // Account state + browser sign-in. The manual key field below stays authoritative for whatever ends up in `apiKey`; this block only says where that key came from and offers the flow that keeps it fresh.
  private renderAccountSetting(container: HTMLElement): void {
    const s = this.plugin.settings
    const signedIn = isDeviceSession(this.plugin)
    const setting = new Setting(container).setName(t('settings.account'))
    if (signedIn) {
      setting.setDesc(
        s.tokenExpiresAt > 0
          ? t('settings.accountSignedIn', {
              date: new Date(s.tokenExpiresAt).toLocaleDateString(getLocale()),
            })
          : t('settings.accountDescription')
      )
      setting.addButton((btn) =>
        btn.setButtonText(t('auth.signOut')).onClick(async () => {
          await signOut(this.plugin)
          this.display()
        })
      )
      return
    }
    setting.setDesc(s.apiKey ? t('settings.accountManualKey') : t('settings.accountNotConnected'))
    setting.addButton((btn) =>
      btn
        .setButtonText(t('auth.signIn'))
        .setCta()
        .onClick(async () => {
          const connected = await startDeviceSignIn(this.app, this.plugin)
          if (connected) this.display()
        })
    )
  }

  // Default-model picker: a dropdown of the gateway's CHAT-CAPABLE models, falling back to a free-text field when the catalogue can't be loaded (no key yet, offline, self-hosted gateway without /v1/models) or when it holds no chat model at all.
  //
  // The filter is not cosmetic. /v1/models lists everything the key can reach — embeddings, image generators, TTS voices, video platforms — and any of those chosen here fails on the first message, because /v1/chat/completions is the only endpoint this plugin calls. filterChatModels reads the backend's own supported_endpoint_types / output_modalities / chat_completions_bridge metadata rather than guessing from the id.
  private async renderModelSetting(container: HTMLElement): Promise<void> {
    const s = this.plugin.settings
    const setting = new Setting(container)
      .setName(t('settings.defaultModel'))
      .setDesc(t('settings.defaultModelDescription'))

    let catalogue: GatewayModel[] = []
    if (s.apiKey) {
      try {
        catalogue = await fetchModels({
          baseUrl: s.baseUrl,
          apiKey: s.apiKey,
          clientApp: CLIENT_APP,
        })
      } catch {
        // Couldn't reach the gateway — fall through to the free-text field.
      }
    }
    const models = filterChatModels(catalogue)

    // A saved default the catalogue positively lists as non-chat is a guaranteed failure on the next send, so clear it here rather than leaving it selected; empty means "the first chat model the gateway lists", which is what the panel then resolves. An id the catalogue simply doesn't list is left alone — it may be an alias an older gateway omits from /v1/models, and resolveChatModel keeps it for exactly that reason, which is also why an unreachable gateway can never wipe the setting.
    //
    // This MUST be handed `catalogue` (raw), never `models` (filtered). resolveChatModel distinguishes "listed as non-chat" from "not listed at all", and a filtered list has already deleted the first case: every non-chat id looks merely absent, so the id is kept and this branch can never fire.
    if (s.defaultModel && resolveChatModel(catalogue, s.defaultModel) !== s.defaultModel) {
      s.defaultModel = ''
      await this.plugin.saveSettings()
    }

    if (models.length > 0) {
      setting.addDropdown((dd) => {
        dd.addOption('', t('settings.firstGatewayModel'))
        for (const m of models) dd.addOption(m.id, m.id)
        // A previously-saved model that's no longer listed should still show.
        if (s.defaultModel && !models.some((m) => m.id === s.defaultModel)) {
          dd.addOption(s.defaultModel, t('settings.savedModel', { model: s.defaultModel }))
        }
        dd.setValue(s.defaultModel)
        dd.onChange(async (value) => {
          s.defaultModel = value
          await this.plugin.saveSettings()
        })
      })
      return
    }

    // The gateway answered but nothing in the catalogue can serve a chat request — a real state for a key scoped to media or embedding models, and one the user has to be told about instead of being handed a blank dropdown.
    if (catalogue.length > 0) setting.setDesc(t('settings.noChatModels'))
    setting.addText((text) =>
      text
        .setPlaceholder('claude-sonnet-4')
        .setValue(s.defaultModel)
        .onChange(async (value) => {
          s.defaultModel = value.trim()
          await this.plugin.saveSettings()
        })
    )
  }
}
