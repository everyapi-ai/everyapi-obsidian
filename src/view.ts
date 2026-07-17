// The EveryAPI chat panel — an ItemView that lives in the right sidebar. Faithful to the Claude Design prototype (plugins/Obsidian.html): a chat whose replies can be inserted into the active note as blockquotes, a context chip showing which note rides along with each question, a model chip for switching gateway models, and an inline onboarding card when no API key is configured yet.
//
// Conversations are deliberately kept in memory only (per panel, per session): persisting chat logs into data.json would churn vault sync and silently store prompt content on disk.

import { fetchModels, type GatewayModel } from '@everyapi-ai/gateway'
import {
  Component,
  type Editor,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  WorkspaceLeaf,
  setIcon,
} from 'obsidian'

import { ObsidianApprovalGate } from './agent/approval'
import { VaultExecutors } from './agent/executors'
import { runAgentLoop, type ChatUsage } from './agent/loop'
import { AGENT_SYSTEM_PROMPT } from './agent/prompt'
import { CLIENT_APP } from './constants'
import { formatTokens, toBlockquote, trimHistoryByChars } from './format'
import { t } from './i18n'
import type EveryApiPlugin from './main'

export const VIEW_TYPE_EVERYAPI = 'everyapi-chat'

interface ChatMessage {
  role: 'user' | 'assistant'
  // The bubble's display text — for an agentic reply this is the cumulative transcript (interim narration + tool-step lines + final answer).
  text: string
  // The model's clean final answer, without the tool-step transcript. Set when the agent loop returns; the insert/append/copy actions use this so the user's note gets the answer, not the internal tool trace. Falls back to `text` when absent (e.g. an aborted turn that never produced a final turn).
  answer?: string
  model?: string
  tokens?: number
  error?: string
}

const SUGGESTION_KEYS = [
  'suggestion.summarize',
  'suggestion.continueWriting',
  'suggestion.reviewNote',
] as const

// Vault-priming digest sent on the first agent turn (Roo's environment_details): how many file paths to list, how deep into the tree, and which folders to skip.
const ENV_ENTRIES = 200
const ENV_DEPTH = 2
const ENV_IGNORED_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules'])
// How many recent messages ride along as conversation history. Count-capped first, then…
const MAX_HISTORY = 24
// …size-capped: even within the count cap, a few very long turns plus the note context could exceed a small model's window, so trim oldest by total chars. ~48k chars ≈ 12k tokens of history, leaving room for the note context.
const MAX_HISTORY_CHARS = 48_000

class ModelSuggestModal extends FuzzySuggestModal<GatewayModel> {
  constructor(
    view: ChatView,
    private models: GatewayModel[],
    private onPick: (id: string) => void
  ) {
    super(view.app)
    this.setPlaceholder(t('picker.switchModel'))
  }
  getItems(): GatewayModel[] {
    return this.models
  }
  getItemText(m: GatewayModel): string {
    return m.id
  }
  onChooseItem(m: GatewayModel): void {
    this.onPick(m.id)
  }
}

export class ChatView extends ItemView {
  plugin: EveryApiPlugin

  private messages: ChatMessage[] = []
  private draft = ''
  private busy = false
  private abortCtl: AbortController | null = null
  private models: GatewayModel[] = []
  private model = ''

  // Owns the markdown renderers of the current message list. Replaced (and the old one unloaded) on every rebuild — passing `this` to MarkdownRenderer.render instead would accumulate child components for every discarded render until the view closes.
  private mdComp: Component | null = null

  private bodyEl: HTMLElement | null = null
  private inputEl: HTMLTextAreaElement | null = null
  private contextChipEl: HTMLElement | null = null
  private modelChipEl: HTMLElement | null = null
  private sendBtnEl: HTMLElement | null = null

  constructor(leaf: WorkspaceLeaf, plugin: EveryApiPlugin) {
    super(leaf)
    this.plugin = plugin
  }

  getViewType(): string {
    return VIEW_TYPE_EVERYAPI
  }
  getDisplayText(): string {
    return 'EveryAPI'
  }
  getIcon(): string {
    return 'everyapi'
  }

  async onOpen(): Promise<void> {
    this.model = this.plugin.settings.defaultModel
    this.addAction('plus', t('action.newChat'), () => this.newChat())
    // Keep the context chip honest as the user moves between notes.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateContextChip()))
    this.render()
  }

  async onClose(): Promise<void> {
    this.abortCtl?.abort()
    this.mdComp?.unload()
    this.mdComp = null
  }

  // Full rebuild. Called on open, on connect/disconnect, and after settings changes — not during streaming (streaming patches the last bubble only).
  render(): void {
    const root = this.contentEl
    root.empty()
    root.addClass('everyapi-chat')
    if (!this.plugin.settings.apiKey) {
      this.renderOnboarding(root)
      return
    }
    this.bodyEl = root.createDiv({ cls: 'everyapi-body' })
    this.renderMessages()
    this.renderFooter(root)
    this.updateContextChip()
  }

  // ---------------- onboarding ----------------

  private renderOnboarding(root: HTMLElement): void {
    const card = root.createDiv({ cls: 'everyapi-onboard' })
    card.createDiv({ cls: 'everyapi-logo' }).createSpan({ cls: 'everyapi-logo-ring' })
    card.createEl('h3', { text: t('onboarding.connectTitle') })
    card.createEl('p', {
      text: t('onboarding.productDescription'),
    })
    const input = card.createEl('input', {
      type: 'password',
      placeholder: 'sk-everyapi-…',
    })
    const errEl = card.createDiv({ cls: 'everyapi-onboard-err' })
    const btn = card.createEl('button', { text: t('onboarding.connect'), cls: 'mod-cta' })
    const submit = async () => {
      const key = input.value.trim()
      if (!key) {
        errEl.setText(t('onboarding.keyRequired'))
        return
      }
      btn.setText(t('onboarding.validating'))
      btn.toggleAttribute('disabled', true)
      try {
        // The real validation: a key that can list models can chat.
        this.models = await fetchModels({
          baseUrl: this.plugin.settings.baseUrl,
          apiKey: key,
          clientApp: CLIENT_APP,
        })
        this.plugin.settings.apiKey = key
        await this.plugin.saveSettings()
        this.render()
        void this.plugin.refreshStatusBar(true)
      } catch (e) {
        errEl.setText(
          t('onboarding.connectionFailed', { error: e instanceof Error ? e.message : String(e) })
        )
        btn.setText(t('onboarding.connect'))
        btn.toggleAttribute('disabled', false)
      }
    }
    btn.addEventListener('click', () => void submit())
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit()
    })
    card.createDiv({
      cls: 'everyapi-onboard-hint',
      text: t('onboarding.keyHint'),
    })
  }

  // ---------------- chat body ----------------

  private renderMessages(): void {
    const body = this.bodyEl
    if (!body) return
    // Follow the bottom only if the user is already there; a rebuild while they're scrolled up reading must not yank them away.
    const stick = this.isNearBottom()
    const prevTop = body.scrollTop
    this.mdComp?.unload()
    this.mdComp = new Component()
    this.mdComp.load()
    body.empty()

    if (this.messages.length === 0) {
      const empty = body.createDiv({ cls: 'everyapi-empty' })
      empty.createDiv({ cls: 'everyapi-logo' }).createSpan({ cls: 'everyapi-logo-ring' })
      empty.createDiv({
        cls: 'everyapi-empty-text',
        text: t('chat.empty'),
      })
      const sugs = empty.createDiv({ cls: 'everyapi-sugs' })
      for (const key of SUGGESTION_KEYS) {
        const suggestion = t(key)
        sugs
          .createEl('button', { cls: 'everyapi-sug', text: suggestion })
          .addEventListener('click', () => void this.send(suggestion))
      }
      return
    }

    this.messages.forEach((msg, i) => {
      const isLast = i === this.messages.length - 1
      const el = body.createDiv({
        cls: `everyapi-msg ${msg.role === 'user' ? 'is-user' : 'is-ai'}`,
      })
      const who = el.createDiv({ cls: 'everyapi-msg-who' })
      who.createSpan({ text: msg.role === 'user' ? t('chat.you') : msg.model || 'EveryAPI' })
      if (msg.role === 'assistant' && msg.tokens) {
        who.createSpan({
          cls: 'everyapi-msg-meta',
          text: t('chat.tokens', { count: formatTokens(msg.tokens) }),
        })
      }
      const bd = el.createDiv({ cls: 'everyapi-msg-body' })
      if (msg.role === 'assistant' && !(this.busy && isLast)) {
        // Finished replies get full markdown rendering; the streaming bubble stays plain text (re-rendering markdown per delta is too heavy).
        void MarkdownRenderer.render(
          this.app,
          msg.text,
          bd,
          this.app.workspace.getActiveFile()?.path ?? '',
          this.mdComp ?? this
        )
      } else {
        bd.setText(msg.text)
        if (this.busy && isLast && msg.role === 'assistant') {
          // Plain text until the stream finishes — keep newlines visible (the is-ai rule switches to normal whitespace for markdown).
          bd.addClass('is-streaming')
          // Announce streamed text to screen readers as it arrives.
          bd.setAttribute('aria-live', 'polite')
          bd.createSpan({ cls: 'everyapi-cursor' })
        }
      }
      if (msg.error) {
        el.createDiv({ cls: 'everyapi-msg-err', text: msg.error })
      }
      if (msg.role === 'assistant' && msg.text && !(this.busy && isLast)) {
        const actions = el.createDiv({ cls: 'everyapi-actions' })
        actions
          .createEl('button', { cls: 'everyapi-insert', text: t('action.insertAtCursor') })
          .addEventListener('click', () => this.insertAtCursor(msg))
        actions
          .createEl('button', { cls: 'everyapi-insert', text: t('action.appendAsQuote') })
          .addEventListener('click', () => void this.appendAsQuote(msg))
        actions
          .createEl('button', { cls: 'everyapi-insert', text: t('action.copy') })
          .addEventListener('click', () => void this.copyReply(msg))
      }
    })
    if (stick) this.scrollToBottom()
    else body.scrollTop = prevTop
  }

  // Cheap per-delta update for the streaming bubble; renderMessages() does the full markdown pass once the stream finishes.
  private patchStreamingBubble(): void {
    const body = this.bodyEl
    if (!body) return
    const last = body.querySelector<HTMLElement>('.everyapi-msg:last-child .everyapi-msg-body')
    const msg = this.messages[this.messages.length - 1]
    if (!last || !msg) return
    const stick = this.isNearBottom()
    last.setText(msg.text)
    last.createSpan({ cls: 'everyapi-cursor' })
    if (stick) this.scrollToBottom()
  }

  private isNearBottom(): boolean {
    const body = this.bodyEl
    if (!body) return true
    return body.scrollHeight - body.scrollTop - body.clientHeight < 60
  }

  private scrollToBottom(): void {
    if (this.bodyEl) this.bodyEl.scrollTop = this.bodyEl.scrollHeight
  }

  // ---------------- footer ----------------

  private renderFooter(root: HTMLElement): void {
    const foot = root.createDiv({ cls: 'everyapi-foot' })
    const box = foot.createDiv({ cls: 'everyapi-box' })

    const ta = box.createEl('textarea', {
      attr: { rows: '1', placeholder: t('input.placeholder') },
    })
    ta.value = this.draft
    ta.addEventListener('input', () => {
      this.draft = ta.value
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(120, ta.scrollHeight)}px`
    })
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        void this.send()
      }
    })
    this.inputEl = ta

    const tools = box.createDiv({ cls: 'everyapi-tools' })
    this.contextChipEl = tools.createSpan({ cls: 'everyapi-chip' })
    // Model chip + send are real buttons so they're keyboard-focusable and activate on Enter/Space (clickable spans are neither).
    this.modelChipEl = tools.createEl('button', { cls: 'everyapi-chip is-model' })
    this.modelChipEl.setAttribute('aria-label', t('picker.switchModel'))
    this.modelChipEl.addEventListener('click', () => void this.openModelPicker())
    this.updateModelChip()

    this.sendBtnEl = tools.createEl('button', { cls: 'everyapi-send' })
    this.updateSendButton()
    this.sendBtnEl.addEventListener('click', () => {
      if (this.busy) this.abortCtl?.abort()
      else void this.send()
    })
  }

  private updateSendButton(): void {
    const btn = this.sendBtnEl
    if (!btn) return
    btn.toggleClass('is-busy', this.busy)
    setIcon(btn, this.busy ? 'square' : 'send')
    btn.setAttribute('aria-label', this.busy ? t('action.stop') : t('action.send'))
  }

  private updateContextChip(): void {
    const chip = this.contextChipEl
    if (!chip) return
    const file = this.app.workspace.getActiveFile()
    chip.setText(file && file.extension === 'md' ? file.name : t('chat.noNoteOpen'))
    chip.toggleClass('is-off', !file || file.extension !== 'md')
  }

  private updateModelChip(): void {
    this.modelChipEl?.setText(
      this.model || this.plugin.settings.defaultModel || t('chat.modelPlaceholder')
    )
  }

  private async openModelPicker(): Promise<void> {
    try {
      await this.ensureModels()
    } catch (e) {
      new Notice(
        t('notice.modelsLoadFailed', { error: e instanceof Error ? e.message : String(e) })
      )
      return
    }
    new ModelSuggestModal(this, this.models, (id) => {
      this.model = id
      this.updateModelChip()
      // Mirror the prototype's shared-default semantics: picking a model here becomes the default for new chats too.
      this.plugin.settings.defaultModel = id
      void this.plugin.saveSettings()
    }).open()
  }

  // Called when the API key or base URL changes: the cached model list (and the session model resolved from it) may belong to the old gateway.
  invalidateModels(): void {
    this.models = []
    this.model = this.plugin.settings.defaultModel
    this.updateModelChip()
  }

  private async ensureModels(): Promise<void> {
    if (this.models.length === 0) {
      const s = this.plugin.settings
      this.models = await fetchModels({
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        clientApp: CLIENT_APP,
      })
    }
    if (!this.model) {
      this.model = this.plugin.settings.defaultModel || this.models[0]?.id || ''
      this.updateModelChip()
    }
  }

  // ---------------- send / stream ----------------

  private newChat(): void {
    if (this.busy) this.abortCtl?.abort()
    this.messages = []
    if (this.plugin.settings.apiKey) this.renderMessages()
  }

  private async send(textArg?: string): Promise<void> {
    const text = (textArg ?? this.draft).trim()
    if (!text || this.busy || !this.plugin.settings.apiKey) return
    const s = this.plugin.settings

    this.draft = ''
    if (this.inputEl) {
      this.inputEl.value = ''
      this.inputEl.style.height = 'auto'
    }

    this.busy = true
    this.updateSendButton()
    try {
      await this.ensureModels()
      if (!this.model) throw new Error(t('chat.noModels'))

      const envDigest = await this.buildEnvDigest()
      const history = trimHistoryByChars(
        this.messages
          .slice(-MAX_HISTORY)
          .filter((m) => m.text)
          .map((m) => ({ role: m.role, content: m.text })),
        MAX_HISTORY_CHARS
      )

      this.messages.push({ role: 'user', text })
      const aiMsg: ChatMessage = { role: 'assistant', text: '', model: this.model }
      this.messages.push(aiMsg)
      this.renderMessages()
      // Sending is an explicit action — always show the new exchange, even if the user had scrolled up beforehand.
      this.scrollToBottom()

      this.abortCtl = new AbortController()
      let usage: ChatUsage | undefined

      // Build a CUMULATIVE transcript so the user sees the whole process — the model's interim narration and each note tool it runs — not just the final turn. `committed` holds finished narration + tool-step lines; `live` is the turn currently streaming. The bubble shows committed+live so it grows rather than being overwritten on each round trip (mirrors the VS Code chatView transcript).
      let committed = ''
      let live = ''
      const flushLive = (): void => {
        if (live.trim()) committed += `${live.trim()}\n\n`
        live = ''
      }
      const render = (): void => {
        aiMsg.text = committed + live
        this.patchStreamingBubble()
      }

      // The chat is always agentic: the vault is always available, so the model reads/searches/edits notes itself via tools instead of us pre-stuffing the active note into the prompt.
      const executors = new VaultExecutors(this.app, new ObsidianApprovalGate(this.app))
      try {
        const result = await runAgentLoop({
          baseUrl: s.baseUrl,
          apiKey: s.apiKey,
          clientApp: CLIENT_APP,
          model: this.model,
          messages: [
            { role: 'system', content: AGENT_SYSTEM_PROMPT },
            ...(envDigest
              ? [
                  {
                    role: 'system' as const,
                    content: `Current vault (reference only — read notes for exact, current content):\n${envDigest}`,
                  },
                ]
              : []),
            ...history,
            { role: 'user' as const, content: text },
          ],
          executors,
          signal: this.abortCtl.signal,
          onTurnStart: () => {
            // A new round trip begins: commit the prior turn's narration so the new turn's deltas don't overwrite it.
            flushLive()
          },
          onTextDelta: (chunk) => {
            live += chunk
            render()
          },
          onToolEvent: (e) => {
            if (e.status === 'running') {
              // Commit any narration that preceded this call, then show the tool call as a muted blockquote line in the bubble.
              flushLive()
              committed += `> \`${e.name}\` ${compactArgs(e.args)}`
              render()
            } else {
              // Append the outcome once the call finishes, on the same line.
              const status =
                e.status === 'ok'
                  ? t('tool.ok')
                  : e.status === 'error'
                    ? t('tool.failed')
                    : t('tool.denied')
              committed += ` — ${status}\n`
              render()
            }
          },
          onUsage: (u) => {
            usage = mergeUsage(usage, u)
          },
        })
        // Commit the final turn's text (it streamed into `live`).
        flushLive()
        aiMsg.text = committed.trimEnd() || result.text
        // The bubble keeps the full transcript, but insert/append/copy use the clean final answer so the user's note doesn't get the tool-step log.
        aiMsg.answer = result.text
        if (result.truncated) {
          const note = t('chat.truncated', { iterations: result.iterations })
          aiMsg.text = `${aiMsg.text}\n\n${note}`
          aiMsg.answer = aiMsg.answer ? `${aiMsg.answer}\n\n${note}` : note
        }
      } catch (e) {
        // Commit whatever narration/tool steps streamed before the failure.
        flushLive()
        aiMsg.text = committed.trimEnd()
        if (!isAbort(e)) {
          aiMsg.error = t('chat.requestFailed', {
            error: e instanceof Error ? e.message : String(e),
          })
        } else if (aiMsg.text === '') {
          // Aborted before anything streamed — drop the empty assistant bubble instead of rendering a model header with no body.
          const idx = this.messages.indexOf(aiMsg)
          if (idx !== -1) this.messages.splice(idx, 1)
        }
        // Aborted with partial text: keep whatever streamed in, no error row.
      }
      if (usage) {
        aiMsg.tokens =
          usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
      }
    } catch (e) {
      this.messages.push({
        role: 'assistant',
        text: '',
        error: t('chat.requestFailed', { error: e instanceof Error ? e.message : String(e) }),
      })
      // Nothing was sent (model resolution / note read failed before the request) — give the user their question back so they can retry.
      this.draft = text
      if (this.inputEl) this.inputEl.value = text
    } finally {
      this.busy = false
      this.abortCtl = null
      this.updateSendButton()
      this.renderMessages()
      this.inputEl?.focus()
      void this.plugin.refreshStatusBar(true)
    }
  }

  // A compact vault snapshot for the first agent turn (Roo's environment_details): the note the user is viewing and a shallow file tree — so the agent orients without spending an opening list_dir round trip. It reads the actual note content itself via read_file, so we don't inline it here. Best-effort: any failure yields '' and the agent just explores via tools.
  private async buildEnvDigest(): Promise<string> {
    try {
      const lines: string[] = []
      const active = this.app.workspace.getActiveFile()
      if (active) lines.push(`Note the user is viewing: ${active.path}`)

      const files = this.app.vault
        .getFiles()
        .map((f) => f.path)
        .filter((p) => !p.split('/').some((seg) => ENV_IGNORED_DIRS.has(seg)))
        .filter((p) => p.split('/').length - 1 <= ENV_DEPTH)
        .sort()
      lines.push('Vault files (truncated — use list_dir/search_text for the rest):')
      lines.push(...files.slice(0, ENV_ENTRIES))
      if (files.length > ENV_ENTRIES) lines.push('…(more files; use list_dir to explore)')
      return lines.join('\n')
    } catch {
      return ''
    }
  }

  // ---------------- programmatic send (editor commands) ----------------

  // Entry point for the command-palette editor actions (Explain selection, Improve writing, …): inject a prompt and send it through the normal path.
  submitPrompt(prompt: string): void {
    const p = prompt.trim()
    if (!p) return
    if (!this.plugin.settings.apiKey) {
      new Notice(t('notice.apiKeyRequired'))
      return
    }
    void this.send(p)
  }

  // ---------------- insert reply into note ----------------

  private activeEditor(): Editor | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null
  }

  // Insert at the cursor of the active editor, replacing the selection if there is one. The richest interaction, but only available when a note is open in edit mode — falls back to a Notice otherwise.
  private insertAtCursor(msg: ChatMessage): void {
    const editor = this.activeEditor()
    if (!editor) {
      new Notice(t('notice.openEditorToInsert'))
      return
    }
    const text = (msg.answer ?? msg.text).trim()
    if (editor.somethingSelected()) editor.replaceSelection(text)
    else editor.replaceRange(text, editor.getCursor())
    new Notice(t('notice.inserted'))
  }

  // Sidebar fallback: append the reply as a blockquote at the end of the active note — predictable, works without an open editor cursor.
  private async appendAsQuote(msg: ChatMessage): Promise<void> {
    const file = this.app.workspace.getActiveFile()
    if (!file || file.extension !== 'md') {
      new Notice(t('notice.openMarkdownNote'))
      return
    }
    const quoted = toBlockquote(msg.answer ?? msg.text)
    await this.app.vault.process(file, (data) => `${data.replace(/\n*$/, '')}\n\n${quoted}\n`)
    new Notice(t('notice.appendedToNote', { file: file.name }))
  }

  private async copyReply(msg: ChatMessage): Promise<void> {
    await navigator.clipboard.writeText(msg.answer ?? msg.text)
    new Notice(t('notice.copied'))
  }
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

/** One-line argument summary for the tool-call transcript line. */
function compactArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args)
  return s.length > 120 ? s.slice(0, 120) + '…' : s
}

/** Sum usage across the agent loop's multiple round trips. */
function mergeUsage(prev: ChatUsage | undefined, next: ChatUsage): ChatUsage {
  return {
    prompt_tokens: (prev?.prompt_tokens ?? 0) + (next.prompt_tokens ?? 0),
    completion_tokens: (prev?.completion_tokens ?? 0) + (next.completion_tokens ?? 0),
    total_tokens: (prev?.total_tokens ?? 0) + (next.total_tokens ?? 0),
  }
}
