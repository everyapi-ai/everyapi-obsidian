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
const EVERYAPI_ICON = `<g fill="currentColor" transform="scale(0.0415110) translate(180.5 0)"><g transform="translate(0.000000,2409.000000) scale(0.100000,-0.100000)" stroke="none"> <path d="M11558 22029 c-338 -36 -809 -181 -995 -307 -32 -21 -260 -166 -508 -322 -247 -156 -472 -302 -500 -325 -27 -23 -72 -54 -100 -70 -74 -42 -473 -310 -609 -409 -64 -48 -121 -84 -126 -81 -11 7 -42 -24 -35 -35 3 -5 0 -12 -6 -16 -7 -4 -9 -3 -5 4 3 6 -1 17 -9 26 -15 14 -20 13 -63 -9 -101 -53 -366 -214 -483 -294 -68 -46 -170 -106 -226 -133 -56 -26 -146 -77 -200 -111 -54 -35 -195 -123 -314 -195 -120 -72 -259 -160 -310 -195 -193 -133 -958 -610 -1043 -650 -52 -25 -291 -165 -816 -479 -332 -198 -1235 -754 -1342 -826 -62 -42 -161 -95 -235 -128 -70 -31 -136 -66 -146 -77 -168 -199 -271 -305 -283 -292 -17 17 -29 13 -224 -70 -211 -90 -221 -96 -270 -167 -25 -34 -61 -81 -81 -103 -61 -67 -103 -117 -152 -182 -26 -34 -54 -68 -61 -76 -17 -17 -212 -451 -250 -557 -118 -327 -146 -687 -95 -1245 7 -71 18 -142 26 -157 11 -23 11 -27 -1 -22 -51 20 -52 0 -39 -1036 5 -477 8 -545 22 -559 15 -15 15 -17 0 -32 -22 -22 -30 -303 -30 -1149 0 -767 3 -809 59 -828 l27 -9 -26 -6 c-38 -10 -37 -5 -45 -344 -7 -298 -1 -383 24 -383 4 0 21 -12 37 -26 26 -22 26 -23 4 -9 -60 36 -78 -7 -60 -145 6 -52 11 -101 10 -107 -1 -14 0 -82 1 -110 0 -10 -5 -85 -11 -168 -13 -156 -18 -1660 -8 -2075 l6 -215 51 -109 c29 -60 52 -118 52 -130 0 -12 112 -204 248 -428 281 -461 222 -393 528 -606 89 -62 224 -146 300 -188 77 -42 166 -95 199 -119 208 -147 369 -251 500 -324 417 -233 552 -313 680 -404 150 -107 196 -131 226 -122 19 6 23 16 20 45 -1 8 15 -13 36 -48 30 -51 47 -68 88 -88 27 -14 50 -25 50 -23 0 8 92 -47 102 -61 28 -40 655 -395 684 -387 10 3 16 1 13 -4 -10 -17 23 -54 119 -132 80 -66 114 -85 235 -137 154 -64 180 -67 173 -15 -3 21 38 -41 43 -65 3 -18 24 -37 73 -66 37 -22 181 -110 318 -194 543 -333 1292 -780 1308 -780 3 0 13 8 23 17 17 17 17 17 11 -7 -3 -14 -3 -31 1 -37 10 -16 1447 -833 1627 -925 29 -15 363 -70 535 -89 53 -5 180 -5 340 2 383 16 496 44 1075 262 129 49 818 451 972 568 40 31 155 102 255 159 101 57 197 114 213 126 17 12 158 99 315 194 417 252 612 375 1028 649 205 135 385 252 400 260 15 8 43 27 63 42 20 16 44 29 52 29 9 0 28 11 44 24 20 17 34 22 44 16 16 -11 29 -4 559 292 252 141 390 224 420 253 26 25 154 107 305 195 143 83 267 157 275 165 23 19 275 164 318 182 45 19 504 298 587 357 33 24 123 87 200 140 175 121 178 123 172 146 -5 21 31 35 64 25 19 -6 215 101 355 196 164 111 209 215 170 400 -32 149 -101 219 -216 219 -45 0 -104 22 -108 40 -5 20 -24 32 -157 101 -66 34 -129 72 -141 85 -12 13 -36 30 -55 38 -19 8 -47 27 -64 41 -36 32 -98 65 -121 65 -9 0 -78 46 -153 103 -165 125 -1231 793 -1639 1028 -306 176 -543 206 -799 100 -140 -58 -841 -480 -1913 -1154 -279 -175 -285 -180 -268 -210 10 -20 10 -20 -17 1 -31 25 -14 31 -188 -70 -189 -110 -400 -247 -423 -274 -11 -13 -29 -26 -41 -28 -23 -5 -165 -91 -223 -135 -19 -15 -48 -32 -63 -39 -15 -6 -30 -18 -33 -26 -3 -7 -13 -12 -22 -9 -10 2 -114 -56 -252 -140 -235 -146 -273 -172 -281 -196 -3 -7 -21 -14 -41 -15 -47 -4 -220 -96 -378 -202 -150 -99 -213 -129 -347 -164 -51 -13 -71 -41 -47 -64 14 -15 8 -16 -68 -16 -95 0 -108 5 -108 39 0 11 -42 26 -111 39 -118 22 -195 50 -207 77 -6 13 -28 33 -49 44 -21 11 -53 33 -71 49 -18 16 -66 44 -105 63 -40 19 -81 44 -93 56 -33 35 -133 76 -196 81 -50 4 -55 6 -43 19 33 33 3 58 -220 178 -49 27 -96 55 -103 62 -7 7 -18 13 -23 13 -6 0 -20 11 -32 24 -23 25 -320 203 -537 321 -69 37 -135 78 -148 91 -13 13 -34 24 -47 24 -14 0 -25 4 -25 9 0 5 -14 14 -31 21 -17 8 -41 24 -53 36 -20 22 -239 151 -432 255 -94 51 -113 53 -133 16 -10 -20 -11 -19 -6 11 7 45 -23 69 -215 172 -91 49 -336 214 -539 363 l-63 47 -60 -31 c-33 -17 -57 -26 -54 -21 3 5 19 15 35 22 31 13 44 31 35 53 -4 12 -656 406 -783 473 -29 16 -63 39 -76 51 -23 22 -241 133 -262 133 -6 0 -14 8 -18 18 -7 20 -85 72 -108 72 -9 0 -21 9 -27 20 -33 62 -117 114 -185 115 -43 0 -49 2 -38 13 17 18 16 19 -119 168 -527 580 -841 1230 -927 1919 -5 45 -15 94 -22 110 -8 19 -14 103 -16 225 -2 107 -5 204 -6 215 -2 24 12 597 19 745 3 69 13 138 30 200 15 52 31 135 36 185 6 52 16 94 24 100 24 18 294 780 294 830 0 14 4 24 9 20 18 -10 48 35 122 181 40 79 76 144 80 144 5 0 20 21 36 48 15 26 32 50 38 54 6 4 20 26 30 49 11 23 38 61 61 85 45 46 98 146 112 210 7 33 9 36 16 17 17 -53 71 -19 178 113 28 35 58 64 65 64 8 0 33 20 56 44 59 63 69 76 100 129 26 43 39 58 36 40 -11 -71 41 -48 309 134 68 46 127 83 131 83 4 0 28 14 52 32 24 18 52 31 61 30 18 -3 55 16 293 151 311 177 672 428 806 560 17 17 30 23 39 17 8 -5 23 -4 34 2 53 27 446 281 446 288 0 4 13 20 28 37 23 24 31 27 41 16 9 -10 17 -11 34 -2 92 48 850 502 1595 954 344 209 362 222 373 258 12 37 12 37 31 17 l19 -21 41 23 c22 13 95 64 162 114 66 50 132 95 146 99 96 30 412 216 1197 706 366 229 450 273 497 261 4 -2 46 -5 92 -8 181 -10 304 -60 623 -253 143 -87 762 -452 843 -497 11 -7 38 26 32 39 -2 7 -30 30 -60 52 -31 22 -58 44 -62 49 -7 13 51 -29 217 -157 77 -58 135 -110 137 -121 4 -30 6 -31 459 -304 528 -317 471 -287 491 -263 17 19 18 19 38 -7 12 -15 20 -31 18 -35 -8 -24 18 -51 123 -128 l115 -83 -85 -83 c-46 -46 -91 -83 -98 -83 -8 0 -25 -8 -38 -18 -13 -10 -32 -21 -41 -25 -27 -9 -156 -98 -228 -156 -35 -28 -67 -51 -73 -51 -5 0 -36 -17 -69 -37 -33 -20 -66 -38 -72 -39 -14 -2 -237 -141 -391 -244 -55 -37 -199 -127 -320 -200 -121 -73 -303 -185 -405 -248 -428 -267 -428 -267 -467 -334 -14 -23 -18 -24 -31 -12 -12 13 -21 10 -70 -18 -127 -71 -833 -497 -1212 -731 -223 -138 -420 -259 -437 -269 -18 -11 -33 -24 -33 -29 0 -5 -10 -19 -22 -31 -11 -11 -22 -31 -24 -42 -1 -12 -7 -32 -13 -46 l-11 -25 1 25 c2 40 0 48 -15 53 -34 13 -96 -62 -72 -86 13 -12 12 -16 -10 -25 -13 -7 -23 -8 -23 -4 8 49 -26 48 -103 -3 -62 -41 -73 -54 -69 -79 1 -5 -6 -6 -15 -2 -11 4 -36 -6 -68 -29 -28 -19 -62 -37 -75 -40 -13 -2 -39 -17 -58 -32 -43 -34 -95 -63 -105 -56 -9 5 -130 -64 -140 -80 -3 -6 -13 -12 -20 -13 -16 -2 -139 -77 -256 -156 -40 -27 -91 -57 -115 -67 -23 -10 -64 -38 -92 -63 -27 -25 -66 -50 -86 -57 -20 -6 -93 -46 -162 -89 -69 -42 -157 -95 -196 -117 -40 -22 -126 -76 -192 -120 -67 -44 -128 -84 -137 -90 -113 -67 -263 -185 -332 -260 -14 -15 -42 -38 -63 -52 -22 -13 -45 -39 -53 -58 -7 -19 -26 -42 -40 -52 -38 -26 -78 -68 -146 -153 -60 -75 -70 -86 -120 -137 -49 -51 -179 -266 -259 -428 -119 -244 -200 -510 -230 -760 -22 -181 -19 -2335 3 -2406 26 -83 74 -146 138 -183 123 -69 264 -31 465 124 50 38 104 77 120 86 17 9 41 31 54 50 20 29 25 32 38 19 18 -19 17 -20 217 114 87 58 186 121 220 139 43 24 69 47 89 78 25 39 30 42 43 29 9 -8 21 -15 29 -15 12 0 413 257 446 286 8 7 46 26 85 42 74 31 206 109 291 173 29 21 57 39 63 39 12 0 72 29 80 39 3 3 23 14 45 24 21 10 61 37 87 58 45 38 92 67 183 112 55 27 430 261 598 374 76 51 152 94 169 97 16 2 47 16 68 30 22 14 106 65 187 112 240 141 643 394 643 405 0 6 4 8 9 5 15 -9 1400 838 2073 1268 25 15 30 34 17 59 -9 17 -6 16 15 -6 l26 -28 58 32 c347 196 675 387 1382 804 585 345 847 498 1345 785 508 293 658 394 876 587 161 144 320 333 409 489 56 99 53 109 -55 174 -47 28 -85 54 -85 57 0 3 11 -2 25 -11 73 -48 154 -86 170 -80 10 4 49 72 91 162 69 143 78 169 119 353 l45 199 10 612 c5 337 10 789 10 1005 l0 392 -44 118 c-141 376 -324 633 -566 795 -106 70 -419 274 -537 349 -48 31 -325 220 -615 420 -290 200 -548 378 -575 394 -125 79 -701 471 -728 495 -30 28 -156 94 -313 165 l-84 37 -46 -33 -47 -33 32 37 c18 20 30 43 27 49 -9 23 -782 560 -825 573 -11 4 -35 -2 -57 -15 -20 -12 -28 -14 -17 -6 60 48 62 51 47 71 -4 6 -104 74 -222 152 -118 79 -233 155 -255 170 -22 15 -152 99 -290 186 -137 88 -283 182 -324 210 -362 245 -1011 389 -1513 336z m-3102 -1753 c-45 -40 -186 -125 -186 -112 0 3 28 21 63 40 34 20 85 54 112 75 66 53 72 51 11 -3z m6251 -219 c-10 -30 -12 -32 -27 -18 -14 15 -14 17 10 33 14 9 25 17 26 17 1 1 -4 -14 -9 -32z m-2550 -1600 c-7 -25 0 -39 28 -56 l20 -13 -20 8 c-11 5 -39 8 -61 8 l-42 1 28 17 c16 9 31 26 35 37 9 28 19 27 12 -2z m3032 -1733 c1 -1 0 -8 -4 -14 -5 -7 -10 -8 -14 -3 -3 5 -15 15 -26 21 -18 11 -16 11 10 6 17 -4 32 -8 34 -10z m-45 -145 c49 -29 45 -34 -5 -8 -35 17 -47 19 -68 10 -24 -11 -25 -10 -7 4 26 20 38 19 80 -6z m729 -413 c37 -21 67 -39 67 -41 0 -8 -136 59 -161 79 -15 12 -35 27 -45 34 -20 14 28 -11 139 -72z m657 -371 c0 -2 -6 -2 -14 1 -8 3 -24 -4 -36 -16 l-22 -22 8 24 c4 12 7 28 7 35 0 8 8 8 29 -3 15 -8 28 -17 28 -19z m-5870 -2120 l64 -70 -58 55 c-31 30 -67 69 -78 85 -24 34 -16 26 72 -70z m-565 -221 c-26 -33 -34 -52 -29 -67 6 -20 6 -20 -10 -4 -11 11 -27 15 -49 11 -31 -4 -31 -4 8 14 23 11 54 35 70 55 44 52 51 45 10 -9z m-5920 -1931 c-7 -47 -9 -49 -29 -31 -11 10 -10 18 5 43 12 19 20 52 21 90 l2 60 4 -60 c2 -33 1 -79 -3 -102z m3550 -702 l20 -24 -22 12 c-13 6 -23 9 -23 5 0 -4 -2 -5 -5 -2 -3 3 -3 13 1 22 4 9 7 16 8 14 1 -2 10 -14 21 -27z m-3465 -701 c0 -5 -14 -7 -32 -3 -46 8 -48 13 -5 13 21 0 37 -4 37 -10z m-30 -1569 c0 -20 -11 -23 -150 -35 -48 -5 -43 -2 38 18 51 13 95 26 99 30 10 10 13 7 13 -13z m13740 -1659 c0 -9 -5 -24 -10 -32 -7 -11 -10 -5 -10 23 0 23 4 36 10 32 6 -3 10 -14 10 -23z m-4163 -272 l88 -8 -99 2 c-70 1 -101 5 -104 14 -2 7 2 10 11 6 9 -3 55 -9 104 -14z m1303 -203 c8 -3 -77 -5 -190 -5 l-205 1 159 8 c87 4 160 10 163 13 4 4 21 0 73 -17z m3180 -131 c-50 -47 -151 -126 -139 -109 8 11 43 43 79 71 63 49 89 66 60 38z m-1069 -41 c-17 -20 -31 -41 -31 -48 -1 -7 -7 0 -15 15 -9 15 -30 31 -51 38 -53 18 -36 22 21 4 47 -14 51 -13 75 5 36 28 36 26 1 -14z m-5336 -15 c13 -7 14 -10 3 -6 -9 3 -33 8 -54 12 -36 7 -36 7 -13 19 19 11 25 11 34 0 5 -7 19 -18 30 -25z m5399 -160 c6 -6 -6 -4 -26 4 -21 9 -47 16 -58 16 -11 0 -20 4 -20 10 0 11 88 -14 104 -30z m474 -135 c-2 -1 -13 -8 -26 -14 -22 -12 -23 -11 -13 8 6 11 11 32 11 48 l1 28 15 -34 c8 -19 13 -35 12 -36z m-368 -209 c0 -7 -71 -46 -83 -46 -7 1 8 12 33 25 50 27 50 27 50 21z m-12970 -370 c-11 -26 -17 -53 -13 -59 3 -6 -5 -2 -19 9 l-25 19 27 25 c15 14 31 37 35 50 5 14 10 20 12 14 2 -6 -6 -32 -17 -58z m1259 -750 c-28 -25 -66 -33 -89 -20 -19 11 -20 14 -5 10 11 -3 34 -2 50 3 33 10 51 13 44 7z m120 -127 c17 -6 31 -17 31 -25 0 -10 -9 -8 -35 7 -50 30 -49 36 4 18z m211 -110 c-12 -23 -19 -47 -16 -54 3 -9 -2 -11 -15 -8 -17 5 -18 8 -6 22 8 9 22 31 31 49 9 17 19 32 21 32 3 0 -4 -18 -15 -41z m8487 -325 c25 -7 24 -8 -18 -19 -24 -7 -90 -29 -147 -49 -129 -45 -157 -46 -42 -2 144 55 159 66 161 119 1 16 3 13 10 -10 7 -23 17 -35 36 -39z"/> </g></g>`

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
