import { fetchModels, type GatewayModel } from '@everyapi-ai/gateway'
import { App, PluginSettingTab, Setting, debounce } from 'obsidian'

import { CLIENT_APP } from './constants'
import { t } from './i18n'
import type EveryApiPlugin from './main'
import { resolveChatModels, type ChatModelsEmptyReason } from './models'

export interface EveryApiSettings {
  apiKey: string
  baseUrl: string
  // Model id used for new chats. Left empty by default — the view resolves it at runtime from /v1/models so we don't ship a hardcoded version number that ages out (same reasoning as apps/raycast).
  defaultModel: string
}

export const DEFAULT_SETTINGS: EveryApiSettings = {
  apiKey: '',
  baseUrl: 'https://api.everyapi.ai/v1',
  defaultModel: '',
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

  // Default-model picker: a dropdown populated from /v1/models when the key works, falling back to a free-text field when the catalog can't be loaded (no key yet, offline, self-hosted gateway without /v1/models).
  private async renderModelSetting(container: HTMLElement): Promise<void> {
    const s = this.plugin.settings
    const setting = new Setting(container)
      .setName(t('settings.defaultModel'))
      .setDesc(t('settings.defaultModelDescription'))

    let models: GatewayModel[] = []
    let catalog: GatewayModel[] | null = null
    let emptyReason: ChatModelsEmptyReason | null = null
    if (s.apiKey) {
      try {
        catalog = await fetchModels({
          baseUrl: s.baseUrl,
          apiKey: s.apiKey,
          clientApp: CLIENT_APP,
        })
        const resolved = resolveChatModels(catalog)
        if (resolved.kind === 'ready') models = resolved.models
        else emptyReason = resolved.reason
      } catch {
        // Couldn't reach the gateway — fall through to the free-text field. Its existing text-field
        // fallback deliberately preserves self-hosted gateways that do not expose `/v1/models`.
      }
    }

    if (models.length > 0) {
      setting.addDropdown((dd) => {
        dd.addOption('', t('settings.firstGatewayModel'))
        for (const m of models) dd.addOption(m.id, m.id)
        // Keep a previously saved non-chat id in storage for manual recovery, but never add it back to
        // the dropdown: doing so would turn the filtered empty state into a fail-open picker.
        dd.setValue(models.some((m) => m.id === s.defaultModel) ? s.defaultModel : '')
        dd.onChange(async (value) => {
          s.defaultModel = value
          await this.plugin.saveSettings()
        })
      })
    } else if (emptyReason) {
      // A successfully-read but unusable catalog is an honest empty state, not an invitation to
      // type one of those same unusable ids back in. Keep free text only for "catalog unavailable".
      setting.setDesc(
        t(emptyReason === 'no-chat-models' ? 'models.noChatCapable' : 'models.noneAvailable')
      )
    } else {
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
}
