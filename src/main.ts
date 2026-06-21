// EveryAPI Obsidian plugin entry point.
//
// What this is, in one sentence: a right-sidebar chat panel that talks to
// the EveryAPI gateway (one OpenAI-compatible /v1 endpoint, 240+ models),
// sends the active note along as context, and inserts replies back into the
// note — plus a status-bar balance readout and a settings tab.
//
// Implements the Claude Design handoff prototype (plugins/Obsidian.html).
// The prototype's cross-surface shared store / simulated billing are design
// fiction; here the gateway is the source of truth: /v1/models for the model
// list, /api/usage/token/ for the balance, real SSE streaming for replies.

import { fetchBalanceUsd, fetchQuotaPerUsd } from '@everyapi-ai/gateway'
import { type Editor, Plugin, WorkspaceLeaf, addIcon } from 'obsidian'

import { CLIENT_APP } from './constants'
import { truncateNote } from './format'
import { DEFAULT_SETTINGS, EveryApiSettings, EveryApiSettingTab } from './settings'
import { ChatView, VIEW_TYPE_EVERYAPI } from './view'

// Cap the selection/note text interpolated into a one-shot editor command so a
// huge selection can't balloon the prompt (cost/latency/context-overflow).
const CMD_MAX_CHARS = 12_000

// Monochrome rendition of the EveryAPI mark (rounded square + ring) —
// Obsidian icons use currentColor, so the brand gradient stays in the panel
// CSS and the icon stays theme-friendly.
const EVERYAPI_ICON = `<rect x="12" y="12" width="76" height="76" rx="20" fill="none" stroke="currentColor" stroke-width="9"/><circle cx="50" cy="50" r="15" fill="none" stroke="currentColor" stroke-width="9"/>`

// Don't hammer /api/usage/token/ — the balance moves per request, not per
// keystroke. Forced refreshes (after a chat completes) bypass this.
const BALANCE_MIN_INTERVAL_MS = 30_000

export default class EveryApiPlugin extends Plugin {
  settings: EveryApiSettings = { ...DEFAULT_SETTINGS }
  private statusEl: HTMLElement | null = null
  private lastBalanceAt = 0

  async onload(): Promise<void> {
    await this.loadSettings()

    addIcon('everyapi', EVERYAPI_ICON)
    this.registerView(VIEW_TYPE_EVERYAPI, (leaf) => new ChatView(leaf, this))

    this.addRibbonIcon('everyapi', 'Open EveryAPI chat', () => void this.activateView())
    this.addCommand({
      id: 'open-chat',
      name: 'Open chat panel',
      callback: () => void this.activateView(),
    })

    // Editor command-palette actions: act on the selection (or whole note),
    // open the panel, and send a preset prompt. editorCallback only exposes
    // these when a markdown editor is focused.
    const editorCmd = (
      id: string,
      name: string,
      build: (text: string, isSelection: boolean) => string,
      wholeNote = false
    ): void => {
      this.addCommand({
        id,
        name,
        editorCallback: (editor: Editor) => {
          const sel = editor.getSelection()
          const isSelection = !wholeNote && sel.trim().length > 0
          const text = truncateNote(isSelection ? sel : editor.getValue(), CMD_MAX_CHARS)
          void this.runPrompt(build(text, isSelection))
        },
      })
    }
    editorCmd(
      'explain-selection',
      'Explain selection or note',
      (text, isSel) =>
        `Explain the following ${isSel ? 'selection' : 'note'} clearly and concisely:\n\n${text}`
    )
    editorCmd(
      'improve-writing',
      'Improve writing',
      (text, isSel) =>
        `Improve the writing of the following ${isSel ? 'selection' : 'note'}, preserving meaning and markdown. Return only the rewritten text:\n\n${text}`
    )
    editorCmd(
      'summarize-note',
      'Summarize note',
      (text) => `Summarize the following note in concise bullet points:\n\n${text}`,
      true
    )
    editorCmd(
      'continue-writing',
      'Continue writing',
      (text) =>
        `Continue writing naturally from where this leaves off. Return only the continuation:\n\n${text}`,
      true
    )

    this.addSettingTab(new EveryApiSettingTab(this.app, this))

    this.statusEl = this.addStatusBarItem()
    this.statusEl.addClass('mod-clickable', 'everyapi-status')
    this.statusEl.setAttribute('aria-label', 'EveryAPI: open chat panel')
    this.statusEl.onClickEvent(() => void this.activateView())
    void this.refreshStatusBar(true)
  }

  // Per Obsidian guidelines we don't detach our leaves in onunload —
  // the workspace remembers them and re-binds on next enable.

  async activateView(): Promise<void> {
    const { workspace } = this.app
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_EVERYAPI)[0] ?? null
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)
      if (!leaf) return
      await leaf.setViewState({ type: VIEW_TYPE_EVERYAPI, active: true })
    }
    void workspace.revealLeaf(leaf)
  }

  // Open the panel and hand a preset prompt to the chat view.
  async runPrompt(prompt: string): Promise<void> {
    await this.activateView()
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_EVERYAPI)[0]
    if (leaf?.view instanceof ChatView) leaf.view.submitPrompt(prompt)
  }

  // Called (debounced) when the API key or base URL changes in settings, and
  // directly after onboarding connects: re-render open panels and re-fetch
  // the status-bar balance against the new credentials.
  onConnectionChanged(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_EVERYAPI)) {
      if (leaf.view instanceof ChatView) {
        leaf.view.invalidateModels()
        leaf.view.render()
      }
    }
    void this.refreshStatusBar(true)
  }

  async refreshStatusBar(force = false): Promise<void> {
    const el = this.statusEl
    if (!el) return
    if (!this.settings.apiKey) {
      el.setText('EveryAPI: not connected')
      return
    }
    const now = Date.now()
    if (!force && now - this.lastBalanceAt < BALANCE_MIN_INTERVAL_MS) return
    this.lastBalanceAt = now
    try {
      const opts = {
        baseUrl: this.settings.baseUrl,
        apiKey: this.settings.apiKey,
        clientApp: CLIENT_APP,
      }
      // Resolve the deployment's real quota→USD peg so a retuned self-hosted
      // instance shows a correct balance, not the default-peg figure.
      const usd = await fetchBalanceUsd(opts, await fetchQuotaPerUsd(opts))
      el.setText(usd === null ? 'EveryAPI' : `EveryAPI: $${usd.toFixed(2)}`)
    } catch {
      // Balance is decoration, not a feature gate — the panel keeps working
      // without it (e.g. self-hosted gateways predating /api/usage/token/).
      el.setText('EveryAPI')
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }
}
