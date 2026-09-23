// Obsidian Modal-backed approval gate for mutating note tools (safety §2). Approval is per call, not a session-wide blanket grant: each write_file / apply_diff blocks on an explicit modal confirmation that shows the user exactly what will change (a unified diff or a new-note preview) before anything touches the vault.
//
// The gate FAILS CLOSED: any non-approving outcome — Cancel, Escape, closing the modal another way, or the turn's AbortSignal firing while the modal is open — resolves to false, so a tool the user did not explicitly approve is denied.

import { App, Modal } from 'obsidian'

import { t } from '../i18n'

/** How a mutating tool asks the user for permission. The view supplies a real implementation backed by Obsidian modals; tests can inject a stub. Returns true to proceed, false to deny. */
export interface ApprovalGate {
  /** Confirm writing `content` to `relPath` (preview is a diff/new-note preview). `truncated` is true when `preview` omits part of the content that will actually be written — the implementation must surface this distinctly, not bury it as trailing text in the preview. `signal` is the turn's abort signal: when it fires the prompt must resolve false and dismiss itself, so pressing Stop is not blocked behind a modal the user then has to answer. */
  confirmWrite(
    relPath: string,
    preview: string,
    isNew: boolean,
    truncated: boolean,
    signal?: AbortSignal
  ): Promise<boolean>
  /** Confirm applying the rendered diff to `relPath`. `truncated` is true when `preview` omits part of the diff that will actually be applied. */
  confirmDiff(
    relPath: string,
    preview: string,
    truncated: boolean,
    signal?: AbortSignal
  ): Promise<boolean>
}

/** Obsidian-backed implementation: a modal showing the change + confirm/cancel. */
export class ObsidianApprovalGate implements ApprovalGate {
  constructor(private readonly app: App) {}

  confirmWrite(
    relPath: string,
    preview: string,
    isNew: boolean,
    truncated: boolean,
    signal?: AbortSignal
  ): Promise<boolean> {
    return this.ask(
      isNew
        ? t('approval.createTitle', { path: relPath })
        : t('approval.overwriteTitle', { path: relPath }),
      preview,
      isNew ? t('approval.create') : t('approval.overwrite'),
      truncated,
      signal
    )
  }

  confirmDiff(
    relPath: string,
    preview: string,
    truncated: boolean,
    signal?: AbortSignal
  ): Promise<boolean> {
    return this.ask(
      t('approval.applyTitle', { path: relPath }),
      preview,
      t('approval.apply'),
      truncated,
      signal
    )
  }

  private ask(
    title: string,
    preview: string,
    confirmLabel: string,
    truncated: boolean,
    signal?: AbortSignal
  ): Promise<boolean> {
    // An already-aborted turn must not raise a modal at all: the user pressed Stop before the tool reached the gate, and popping a dialog they have to dismiss is the opposite of cancelling.
    if (signal?.aborted) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      new ApprovalModal(this.app, title, preview, confirmLabel, truncated, resolve, signal).open()
    })
  }
}

/** A confirm/cancel modal that previews a proposed vault change. `resolve` is called exactly once: with true only when the confirm button is clicked, with false on Cancel, on any dismissal (onClose), or when the turn is aborted while the modal is open — so the gate fails closed. */
class ApprovalModal extends Modal {
  private decided = false
  private detachAbort: (() => void) | null = null

  constructor(
    app: App,
    private readonly title: string,
    private readonly preview: string,
    private readonly confirmLabel: string,
    private readonly truncated: boolean,
    private readonly resolve: (approved: boolean) => void,
    private readonly signal?: AbortSignal
  ) {
    super(app)
  }

  onOpen(): void {
    // Stop has to reach an open approval prompt: without this the user cancels the turn, the modal stays up, and the tool is still waiting on an answer to a question that no longer matters.
    const signal = this.signal
    if (signal) {
      const onAbort = (): void => this.decide(false)
      signal.addEventListener('abort', onAbort, { once: true })
      this.detachAbort = () => signal.removeEventListener('abort', onAbort)
    }
    const { contentEl, titleEl } = this
    titleEl.setText(this.title)
    contentEl.addClass('everyapi-approval')
    contentEl.createDiv({
      cls: 'everyapi-approval-hint',
      text: t('approval.reviewHint'),
    })
    if (this.truncated) {
      // This preview does NOT show everything that will be written — the tool executor caps preview length for renderability, but writes the full, untruncated content/diff on approval. Call this out as a distinct, visually prominent element rather than trailing text inside the scrollable <pre> block, which a user can easily miss.
      contentEl.createDiv({
        cls: 'everyapi-approval-warning',
        text: t('approval.truncatedWarning'),
      })
    }
    // <pre> preserves the diff's whitespace/alignment; the agent never instructs the user, this is only rendered DATA, so no markdown interpretation.
    contentEl.createEl('pre', { cls: 'everyapi-approval-preview' }).setText(this.preview)

    const buttons = contentEl.createDiv({ cls: 'everyapi-approval-actions' })
    const cancel = buttons.createEl('button', { text: t('approval.cancel') })
    cancel.addEventListener('click', () => this.decide(false))
    const confirm = buttons.createEl('button', { text: this.confirmLabel, cls: 'mod-cta' })
    confirm.addEventListener('click', () => this.decide(true))
    confirm.focus()
  }

  private decide(approved: boolean): void {
    if (this.decided) return
    this.decided = true
    this.detachAbort?.()
    this.detachAbort = null
    this.resolve(approved)
    this.close()
  }

  onClose(): void {
    this.detachAbort?.()
    this.detachAbort = null
    this.contentEl.empty()
    // Dismissed without an explicit decision (Esc / click-away) → fail closed.
    if (!this.decided) {
      this.decided = true
      this.resolve(false)
    }
  }
}
