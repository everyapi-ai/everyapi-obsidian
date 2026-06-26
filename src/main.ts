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

// Monochrome silhouette of the EveryAPI mark (the hexagon "e") in a
// 0 0 100 100 viewBox — Obsidian icons use currentColor, so the brand gradient
// stays in the panel CSS and the icon stays theme-friendly.
const EVERYAPI_ICON = `<g fill="currentColor" transform="scale(0.0518403) translate(164.5 0)"><g transform="translate(0.000000,1929.000000) scale(0.100000,-0.100000)" stroke="none">
<path d="M9075 19164 c-32 -8 -91 -32 -130 -53 -38 -21 -1987 -1217 -4330
-2659 -4745 -2919 -4373 -2681 -4449 -2843 -68 -143 -82 287 163 -4976 167
-3582 226 -4777 237 -4819 30 -115 102 -227 189 -294 29 -22 1489 -757 3405
-1714 3336 -1668 3355 -1677 3437 -1688 95 -13 185 -2 279 34 85 33 7773 5522
7861 5613 68 70 123 173 142 263 7 34 11 230 11 555 l0 503 -1372 97 c-755 54
-1380 98 -1389 97 -10 0 -29 -25 -47 -62 -18 -36 -54 -85 -84 -115 -71 -69
-4978 -3572 -5048 -3603 -48 -22 -69 -25 -172 -25 l-118 0 -2166 1083 c-1867
933 -2173 1089 -2216 1130 -92 86 -133 175 -143 315 -3 45 -64 1427 -136 3071
-140 3235 -135 3040 -81 3156 55 118 -57 46 2867 1842 1496 919 2747 1686
2781 1703 126 67 252 68 401 2 122 -55 3156 -1567 3152 -1571 -2 -2 -1977
-1036 -4389 -2296 -2412 -1261 -4407 -2304 -4433 -2318 -180 -97 -271 -326
-205 -517 18 -52 163 -292 577 -955 305 -487 569 -906 588 -933 81 -111 219
-172 372 -165 80 4 97 8 182 50 74 35 1959 1019 4049 2113 118 62 613 321
1100 575 487 254 1391 727 2011 1051 619 323 1133 591 1142 595 16 6 17 -21
17 -385 l0 -391 1380 0 1380 0 0 2498 c0 2723 3 2557 -56 2675 -40 80 -93 144
-159 194 -98 74 -6250 3146 -6342 3167 -87 19 -177 19 -258 0z"/>
</g></g>`

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
