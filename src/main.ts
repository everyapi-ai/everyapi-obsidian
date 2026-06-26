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
<path d="M5478 9580 c-58 -10 -123 -31 -253 -82 -98 -38 -193 -92 -370 -212
-49 -34 -106 -69 -126 -78 -19 -9 -82 -47 -138 -84 -57 -38 -171 -112 -255
-165 -83 -54 -173 -111 -201 -129 -27 -18 -369 -236 -760 -485 -390 -249 -846
-540 -1012 -648 -166 -108 -319 -205 -340 -217 -148 -80 -387 -246 -444 -307
-103 -112 -189 -269 -224 -408 -9 -38 -22 -81 -29 -94 -16 -35 -13 -3753 4
-3837 15 -80 57 -208 87 -268 37 -73 106 -140 228 -221 60 -40 540 -332 1065
-648 525 -315 1135 -686 1355 -822 642 -399 698 -426 942 -455 206 -25 437 21
657 132 44 22 255 149 470 282 215 134 443 273 506 311 63 38 151 91 195 118
188 118 1164 714 1430 875 159 96 310 190 335 209 80 61 115 148 86 217 -19
45 -86 90 -581 391 -115 71 -286 178 -380 238 -286 185 -357 213 -505 198
-107 -12 -122 -18 -290 -121 -292 -179 -1148 -712 -1380 -859 -355 -224 -420
-253 -529 -230 -70 14 -123 41 -266 134 -262 170 -1358 838 -1640 1000 -269
154 -336 206 -442 344 -98 127 -169 239 -223 354 -59 125 -82 199 -123 392
-28 132 -32 173 -35 335 -3 202 10 331 54 502 89 354 285 665 552 875 125 99
189 142 446 303 126 78 351 220 500 314 234 149 704 447 1251 794 83 52 227
147 320 210 219 148 278 177 351 169 66 -7 107 -29 488 -260 306 -185 518
-312 666 -400 52 -30 108 -69 123 -85 l28 -29 -158 -102 c-87 -57 -378 -244
-648 -416 -2160 -1381 -2023 -1291 -2145 -1418 -165 -175 -258 -349 -321 -602
-17 -68 -25 -1133 -9 -1187 6 -20 26 -53 44 -73 32 -34 36 -35 104 -35 39 0
84 6 99 12 15 7 175 105 355 218 1722 1080 3260 2041 3503 2191 333 204 387
242 480 334 52 51 111 122 138 165 61 100 121 251 149 380 21 100 23 125 23
515 0 457 -2 476 -65 612 -47 100 -91 159 -179 239 -89 80 -142 117 -461 321
-146 94 -308 199 -360 234 -52 35 -191 125 -308 199 -118 74 -257 164 -310
198 -53 35 -180 116 -282 180 -102 63 -273 174 -380 246 -209 139 -278 174
-429 213 -75 19 -128 25 -241 28 -80 2 -166 0 -192 -5z"/>
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
