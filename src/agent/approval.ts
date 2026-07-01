// Obsidian Modal-backed approval gate for mutating note tools (safety §2).
// Approval is per call, not a session-wide blanket grant: each write_file /
// apply_diff blocks on an explicit modal confirmation that shows the user
// exactly what will change (a unified diff or a new-note preview) before
// anything touches the vault.
//
// The gate FAILS CLOSED: any non-approving outcome — Cancel, Escape, or
// closing the modal another way — resolves to false, so a tool the user did not
// explicitly approve is denied.

import { App, Modal } from 'obsidian'

/**
 * How a mutating tool asks the user for permission. The view supplies a real
 * implementation backed by Obsidian modals; tests can inject a stub. Returns
 * true to proceed, false to deny.
 */
export interface ApprovalGate {
  /** Confirm writing `content` to `relPath` (preview is a diff/new-note preview). */
  confirmWrite(relPath: string, preview: string, isNew: boolean): Promise<boolean>
  /** Confirm applying the rendered diff to `relPath`. */
  confirmDiff(relPath: string, preview: string): Promise<boolean>
}

/** Obsidian-backed implementation: a modal showing the change + confirm/cancel. */
export class ObsidianApprovalGate implements ApprovalGate {
  constructor(private readonly app: App) {}

  confirmWrite(relPath: string, preview: string, isNew: boolean): Promise<boolean> {
    return this.ask(
      isNew ? `Create note ${relPath}?` : `Overwrite note ${relPath}?`,
      preview,
      isNew ? 'Create note' : 'Overwrite note'
    )
  }

  confirmDiff(relPath: string, preview: string): Promise<boolean> {
    return this.ask(`Apply this edit to ${relPath}?`, preview, 'Apply edit')
  }

  private ask(title: string, preview: string, confirmLabel: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      new ApprovalModal(this.app, title, preview, confirmLabel, resolve).open()
    })
  }
}

/**
 * A confirm/cancel modal that previews a proposed vault change. `resolve` is
 * called exactly once: with true only when the confirm button is clicked, with
 * false on Cancel or any dismissal (onClose), so the gate fails closed.
 */
class ApprovalModal extends Modal {
  private decided = false

  constructor(
    app: App,
    private readonly title: string,
    private readonly preview: string,
    private readonly confirmLabel: string,
    private readonly resolve: (approved: boolean) => void
  ) {
    super(app)
  }

  onOpen(): void {
    const { contentEl, titleEl } = this
    titleEl.setText(this.title)
    contentEl.addClass('everyapi-approval')
    contentEl.createDiv({
      cls: 'everyapi-approval-hint',
      text: 'EveryAPI proposes the change below. Review it before approving — nothing is written until you do.',
    })
    // <pre> preserves the diff's whitespace/alignment; the agent never instructs
    // the user, this is only rendered DATA, so no markdown interpretation.
    contentEl.createEl('pre', { cls: 'everyapi-approval-preview' }).setText(this.preview)

    const buttons = contentEl.createDiv({ cls: 'everyapi-approval-actions' })
    const cancel = buttons.createEl('button', { text: 'Cancel' })
    cancel.addEventListener('click', () => this.decide(false))
    const confirm = buttons.createEl('button', { text: this.confirmLabel, cls: 'mod-cta' })
    confirm.addEventListener('click', () => this.decide(true))
    confirm.focus()
  }

  private decide(approved: boolean): void {
    if (this.decided) return
    this.decided = true
    this.resolve(approved)
    this.close()
  }

  onClose(): void {
    this.contentEl.empty()
    // Dismissed without an explicit decision (Esc / click-away) → fail closed.
    if (!this.decided) {
      this.decided = true
      this.resolve(false)
    }
  }
}
