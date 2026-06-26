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
const EVERYAPI_ICON = `<g fill="currentColor" transform="scale(0.1)"><g transform="translate(0.000000,1000.000000) scale(0.100000,-0.100000)">
<path d="M4469 8960 c-54 -14 -133 -51 -234 -110 -92 -54 -195 -114 -365 -213
-52 -30 -151 -87 -220 -127 -168 -98 -273 -158 -475 -275 -93 -53 -192 -111
-220 -128 -27 -16 -124 -72 -215 -124 -484 -278 -527 -309 -596 -418 -86 -138
-79 -23 -82 -1350 -2 -770 1 -1208 7 -1260 8 -62 21 -101 57 -173 76 -156 98
-172 582 -453 53 -31 169 -98 257 -149 88 -51 185 -107 215 -125 30 -17 123
-71 205 -120 83 -48 240 -141 350 -205 110 -65 216 -127 236 -139 107 -63 302
-89 428 -57 71 18 82 24 346 175 99 57 224 129 278 160 332 190 676 388 817
471 146 84 380 219 487 279 128 72 170 105 178 139 9 44 -17 88 -68 113 -42
22 -132 73 -347 200 -284 166 -436 248 -482 260 -65 15 -167 7 -215 -18 -21
-11 -81 -45 -133 -75 -165 -96 -807 -468 -953 -552 -54 -31 -102 -56 -108 -56
-5 0 -40 17 -77 39 -117 67 -384 221 -477 275 -49 29 -151 88 -225 131 -274
158 -326 190 -369 230 -62 57 -119 137 -144 203 -22 56 -22 64 -22 692 0 722
-4 681 85 808 54 78 117 128 267 213 112 64 328 189 455 263 48 28 144 84 215
125 70 40 202 118 293 172 220 131 225 133 340 133 124 1 97 13 440 -189 58
-34 132 -77 165 -95 110 -60 112 -53 -38 -137 -73 -42 -177 -101 -232 -133
-100 -58 -524 -300 -665 -380 -41 -24 -111 -64 -155 -91 -44 -26 -107 -62
-140 -80 -196 -106 -280 -197 -322 -350 -16 -56 -18 -112 -18 -449 0 -432 3
-459 62 -510 26 -23 43 -30 76 -30 44 0 56 7 267 127 58 34 152 88 210 121
139 79 302 172 425 242 55 32 147 84 205 117 58 33 218 124 355 203 138 79
279 160 315 180 36 20 173 99 305 175 132 76 270 156 308 176 140 78 240 144
268 178 16 19 41 65 56 101 l27 65 4 324 c3 302 2 328 -17 390 -24 80 -66 149
-114 187 -32 25 -348 210 -587 344 -96 53 -213 121 -410 235 -74 43 -169 98
-211 121 -42 24 -119 67 -170 96 -156 90 -217 110 -339 114 -58 2 -121 -1
-141 -6z"/>
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
