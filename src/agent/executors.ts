// Per-host executors for the EveryAPI agentic NOTES tool set, implemented against the Obsidian Vault API and confined to the vault. The gateway only translates tool schemas; it does NOT gate execution — so every safety guard is enforced HERE, before any tool runs:
//
//   1. Path confinement: every path is run through the pure lexical guard (paths.ts) and rejected if it escapes the vault ('..', absolute). The Vault API is already vault-scoped; this adds clean errors + defense.
//   2. Approval before mutating: write_file / apply_diff block on an explicit per-call user confirmation (Obsidian modal); reject => `denied` result.
//   3. Output caps: read/list/search output is size-bounded.
//   4. Untrusted data: tool output is never treated as instructions; we never auto-escalate approval based on what a note said.
//   5. Secrets: obvious credential-looking files are skipped on read/search (a vault has no shell secrets, but a synced repo might).
//   6. Regex safety: search_text patterns are screened by a pure heuristic (regex-safety.ts) for the classic catastrophic-backtracking shape before compiling — Electron's renderer is single-threaded and a pathological RegExp.test() call cannot be interrupted or timed out.
//   7. Cancellation: every executor takes the turn's AbortSignal. A vault-wide search checks it per file, and an open approval modal is closed as a denial, so Stop reaches work already in flight rather than only the gap between tool calls.
//   8. Undo: every mutating call records the note's pre-edit content in a per-turn journal BEFORE writing, so the panel can offer one-click "Revert this turn" (revertVaultEdits below). Approval remains the primary safety net; the journal is the second one.
//
// Every executor returns a structured result envelope and NEVER throws into the loop — with one deliberate exception: an abort propagates as an AbortError so the turn ends as a cancellation instead of being reported to the model as a tool failure. The pure diff/match logic lives in diff.ts; the line-numbering in format.ts; the regex guard in regex-safety.ts — all unit-tested without Obsidian.

import { App, TFile, TFolder, type Vault } from 'obsidian'

import { isAbortError, throwIfAborted } from './abort'
import type { ApprovalGate } from './approval'
import {
  type ToolResult,
  applyDiff as applyDiffPure,
  denied,
  err,
  ok,
  previewNewFile,
  unifiedDiff,
} from './diff'
import { formatNumberedLines } from './format'
import { resolveVaultPath } from './paths'
import { unsafeSearchPatternReason } from './regex-safety'
import type { ToolName } from './tools'

// ---- caps ---------------------------------------------------------------------

const LIST_MAX_ENTRIES = 3000
const SEARCH_MAX_HITS = 200
const SEARCH_MAX_BYTES = 64 * 1024
const SEARCH_MAX_FILES = 5000
const SEARCH_CONTEXT_LINES = 2
const READ_MAX_BYTES = 2_000_000

/** Heavy/noise directories that listings and search skip by default. */
const IGNORED_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.DS_Store'])

/** Credential files whose contents are withheld on agentic read/search. */
const SECRET_FILE_RE =
  /(^|\/)(\.env(\.[\w-]+)?|\.npmrc|\.netrc|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.keystore)$/i

/** One vault mutation this turn applied, captured BEFORE the write. `before` is null when the note did not exist, i.e. the turn created it. */
export interface VaultEdit {
  path: string
  before: string | null
}

export class VaultExecutors {
  private readonly vault: Vault
  // First touch wins, so reverting restores the state the turn started from rather than an intermediate one when the model edits the same note twice. Insertion-ordered, which is also the order the writes happened.
  private readonly journal = new Map<string, VaultEdit>()

  constructor(
    app: App,
    private readonly approval: ApprovalGate
  ) {
    this.vault = app.vault
  }

  /** The mutations recorded so far, oldest first. The caller (the panel) takes them once a turn ends and offers a revert; the executors keep no history beyond this. */
  takeJournal(): VaultEdit[] {
    const edits = [...this.journal.values()]
    this.journal.clear()
    return edits
  }

  private record(path: string, before: string | null): void {
    if (!this.journal.has(path)) this.journal.set(path, { path, before })
  }

  /** Dispatch a parsed tool call to its executor. Resolves to a ToolResult — a guard rejection becomes model-visible feedback rather than a crashed loop. The one thing that DOES throw is an abort: the user pressing Stop must end the turn, not be reported to the model as a tool failure it should retry. */
  async execute(
    name: ToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    try {
      switch (name) {
        case 'read_file':
          return await this.readFile(str(args.path), int(args.offset), int(args.limit))
        case 'list_dir':
          return this.listDir(str(args.path), bool(args.recursive))
        case 'search_text':
          return await this.searchText(
            str(args.pattern),
            str(args.path),
            str(args.file_glob),
            signal
          )
        case 'write_file':
          return await this.writeFile(str(args.path), strOrNull(args.content), signal)
        case 'apply_diff':
          return await this.applyDiff(
            str(args.path),
            str(args.diff),
            bool(args.replace_all),
            signal
          )
      }
    } catch (e) {
      if (isAbortError(e)) throw e
      return err(
        e instanceof Error ? e.message : String(e),
        'Unexpected failure; adjust the arguments and retry.'
      )
    }
  }

  // ---- read_file ------------------------------------------------------------

  private async readFile(path: string, offset?: number, limit?: number): Promise<ToolResult> {
    if (!path) return err("'path' is required.")
    const rel = resolveVaultPath(path)
    if (rel === null) return outside(path)
    if (!rel)
      return err("'.' is the vault root, not a file.", 'Use list_dir to inspect the vault root.')
    if (SECRET_FILE_RE.test(rel)) {
      return err(
        `Refusing to read '${rel}': it looks like a credential file.`,
        'Ask the user to open or attach this file explicitly if its contents are truly needed.'
      )
    }
    const file = this.vault.getAbstractFileByPath(rel)
    if (file === null) {
      return err(
        `File not found: ${rel}`,
        'Use list_dir or search_text to locate the correct path.'
      )
    }
    if (file instanceof TFolder) {
      return err(`'${rel}' is a folder.`, 'Use list_dir to inspect a folder.')
    }
    if (!(file instanceof TFile)) {
      return err(`'${rel}' is not a readable file.`)
    }
    if (file.stat.size > READ_MAX_BYTES) {
      return err(
        `'${rel}' is too large to read (${file.stat.size} bytes).`,
        'This tool reads text notes up to ~2 MB.'
      )
    }
    const text = await this.vault.cachedRead(file)
    if (text.includes('\u0000')) {
      return err(`'${rel}' appears to be a binary file.`, 'This tool only reads text files.')
    }
    const numbered = formatNumberedLines(rel, text, offset, limit)
    return numbered.ok ? ok(numbered.text) : err(numbered.error, numbered.suggestion)
  }

  // ---- list_dir -------------------------------------------------------------

  private listDir(path: string, recursive?: boolean): ToolResult {
    if (path === '') return err("'path' is required.", "Use '.' for the vault root.")
    const rel = resolveVaultPath(path)
    if (rel === null) return outside(path)

    // '' (from '.') means the vault root folder.
    const folder = rel === '' ? this.vault.getRoot() : this.vault.getAbstractFileByPath(rel)
    if (folder === null) return err(`Directory not found: ${rel || path}`)
    if (folder instanceof TFile) return err(`'${rel}' is a file.`, 'Use read_file to read a file.')
    if (!(folder instanceof TFolder)) return err(`'${rel || '.'}' is not a folder.`)

    const entries: string[] = []
    let truncated = false

    const pushChildren = (parent: TFolder, prefix: string): boolean => {
      const children = [...parent.children].sort((a, b) => {
        const ad = a instanceof TFolder ? 0 : 1
        const bd = b instanceof TFolder ? 0 : 1
        return ad - bd || a.name.localeCompare(b.name)
      })
      for (const child of children) {
        if (child instanceof TFolder && IGNORED_DIRS.has(child.name)) continue
        if (entries.length >= LIST_MAX_ENTRIES) {
          truncated = true
          return false
        }
        const label = `${prefix}${child.name}${child instanceof TFolder ? '/' : ''}`
        entries.push(label)
        if (recursive && child instanceof TFolder) {
          if (!pushChildren(child, `${label}`)) return false
        }
      }
      return true
    }

    pushChildren(folder, '')

    const relRoot = rel || '.'
    if (!entries.length) return ok(`Directory ${relRoot} is empty.`)
    entries.sort()
    const more = truncated
      ? `\n…(more than ${LIST_MAX_ENTRIES} entries; narrow the path or use recursive=false)`
      : ''
    return ok(`Directory: ${relRoot}\n${entries.join('\n')}${more}`)
  }

  // ---- search_text ----------------------------------------------------------

  private async searchText(
    pattern: string,
    path: string,
    glob?: string,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    if (!pattern) return err("'pattern' is required.")
    const unsafeReason = unsafeSearchPatternReason(pattern)
    if (unsafeReason) {
      return err(unsafeReason, 'Simplify the pattern (avoid nested repeated groups) and retry.')
    }
    if (path === '') return err("'path' is required.", "Use '.' for the whole vault.")
    const base = resolveVaultPath(path)
    if (base === null) return outside(path)

    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch (e) {
      return err(
        `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`,
        'Fix the regex syntax (JavaScript RegExp) and retry.'
      )
    }

    let globRe: RegExp | null
    try {
      globRe = glob ? globToRegExp(glob) : null
    } catch {
      return err(`Invalid file_glob: ${glob}`, "Use a simple glob like '*.md' or 'Folder/**/*.md'.")
    }

    const prefix = base ? `${base}/` : ''
    const candidates = this.vault
      .getFiles()
      .filter((f) => (base === '' ? true : f.path === base || f.path.startsWith(prefix)))
      .filter((f) => !f.path.split('/').some((seg) => IGNORED_DIRS.has(seg)))
      .filter((f) => !SECRET_FILE_RE.test(f.path))
      .filter((f) => (globRe ? globRe.test(f.path) : true))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, SEARCH_MAX_FILES)

    const out: string[] = []
    let hits = 0
    let bytes = 0
    let truncated = false

    outer: for (const file of candidates) {
      // A vault-wide scan is the longest-running tool here (thousands of cachedRead calls), so Stop has to be observable inside the loop — checking only between tool calls leaves the user waiting out a scan they already cancelled.
      throwIfAborted(signal)
      if (file.stat.size > READ_MAX_BYTES) continue
      let text: string
      try {
        text = await this.vault.cachedRead(file)
        if (text.includes('\u0000')) continue // binary
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0
        if (!re.test(lines[i]!)) continue
        const from = Math.max(0, i - SEARCH_CONTEXT_LINES)
        const to = Math.min(lines.length - 1, i + SEARCH_CONTEXT_LINES)
        const block: string[] = [`${file.path}:${i + 1}:`]
        for (let j = from; j <= to; j++) {
          const marker = j === i ? '>' : ' '
          const lineText = lines[j]!.length > 240 ? lines[j]!.slice(0, 240) + ' …' : lines[j]!
          block.push(`${marker} ${j + 1}\t${lineText}`)
        }
        const chunk = block.join('\n')
        bytes += chunk.length
        out.push(chunk)
        hits++
        if (hits >= SEARCH_MAX_HITS || bytes >= SEARCH_MAX_BYTES) {
          truncated = true
          break outer
        }
      }
    }

    if (!out.length) return ok(`No matches for /${pattern}/ under ${base || '.'}.`)
    const more = truncated
      ? `\n…(results capped; tighten the pattern, narrow the path, or set file_glob)`
      : ''
    return ok(`Matches for /${pattern}/:\n\n${out.join('\n\n')}${more}`)
  }

  // ---- write_file -----------------------------------------------------------

  private async writeFile(
    path: string,
    content: string | null,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    if (!path) return err("'path' is required.")
    if (content === null)
      return err("'content' is required.", 'Send the complete file content as a string.')
    const rel = resolveVaultPath(path)
    if (rel === null) return outside(path)
    if (!rel) return err("'.' is the vault root, not a file path.")

    const existing = this.vault.getAbstractFileByPath(rel)
    if (existing instanceof TFolder) return err(`'${rel}' is a folder.`)
    const file = existing instanceof TFile ? existing : null
    const isNew = file === null

    let oldText = ''
    if (file) oldText = await this.vault.read(file)

    const preview = isNew ? previewNewFile(content) : unifiedDiff(rel, oldText, content)
    const approved = await this.approval.confirmWrite(
      rel,
      preview.text,
      isNew,
      preview.truncated,
      signal
    )
    if (!approved) return denied('Propose a different change or explain why this edit is needed.')

    // Record the pre-edit state BEFORE writing: a crash or a mid-write abort must not leave a mutation the panel cannot offer to undo.
    this.record(rel, isNew ? null : oldText)
    if (file) {
      await this.vault.modify(file, content)
    } else {
      await this.ensureParentFolder(rel)
      await this.vault.create(rel, content)
    }
    const verb = isNew ? 'Created' : 'Overwrote'
    return ok(`${verb} ${rel} (${content.split('\n').length} lines).`)
  }

  // ---- apply_diff -----------------------------------------------------------

  private async applyDiff(
    path: string,
    diff: string,
    replaceAll?: boolean,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    if (!path) return err("'path' is required.")
    if (!diff) return err("'diff' is required.", 'Send one or more SEARCH/REPLACE blocks.')
    const rel = resolveVaultPath(path)
    if (rel === null) return outside(path)
    if (!rel) return err("'.' is the vault root, not a file path.")

    const file = this.vault.getAbstractFileByPath(rel)
    if (file === null) {
      return err(
        `File not found: ${rel}`,
        'apply_diff only edits existing files; use write_file to create one.'
      )
    }
    if (file instanceof TFolder) return err(`'${rel}' is a folder.`)
    if (!(file instanceof TFile)) return err(`'${rel}' is not an editable file.`)

    const rawOld = await this.vault.read(file)
    // Match and edit in LF space, restoring the file's dominant line ending on write — so an LF-authored SEARCH block matches a CRLF note (the most common apply_diff failure) without corrupting line endings.
    const crlf = rawOld.includes('\r\n')
    const oldText = crlf ? rawOld.replace(/\r\n/g, '\n') : rawOld

    const applied = applyDiffPure(rel, oldText, diff, { replaceAll: replaceAll === true })
    if (!applied.ok) return err(applied.error, applied.suggestion)

    const preview = unifiedDiff(rel, oldText, applied.text)
    const approved = await this.approval.confirmDiff(rel, preview.text, preview.truncated, signal)
    if (!approved) return denied('Propose a different edit or explain why this change is needed.')

    this.record(rel, rawOld)
    await this.vault.modify(file, crlf ? applied.text.replace(/\n/g, '\r\n') : applied.text)
    // Surface any location-uncertainty diagnostics from locateBlock (e.g. a match that landed far from the requested :start_line: hint) instead of silently dropping them — the model/user should see when a SEARCH block was ambiguous even though the edit still applied.
    const warningNote = applied.warnings?.length ? `\n${applied.warnings.join('\n')}` : ''
    return ok(`Applied ${applied.blocks} edit block(s) to ${rel}.${warningNote}`)
  }

  // ---- helpers --------------------------------------------------------------

  /** Create the chain of parent folders for `rel` if they don't exist yet, so vault.create on a nested path doesn't fail (Obsidian won't auto-mkdir). */
  private async ensureParentFolder(rel: string): Promise<void> {
    const slash = rel.lastIndexOf('/')
    if (slash <= 0) return
    const dir = rel.slice(0, slash)
    if (this.vault.getAbstractFileByPath(dir) instanceof TFolder) return
    const parts = dir.split('/')
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      if (!(this.vault.getAbstractFileByPath(acc) instanceof TFolder)) {
        try {
          await this.vault.createFolder(acc)
        } catch {
          // A concurrent create may have made it; ignore and let the final vault.create surface any real failure.
        }
      }
    }
  }
}

// ---- revert ------------------------------------------------------------------

/** Per-path outcome of a revert: what was restored and what could not be. Reported rather than swallowed — a partial revert that claims success is worse than one that names the notes it left alone. */
export interface RevertOutcome {
  reverted: string[]
  failed: string[]
}

/** Undo a turn's vault mutations, newest first. A note the turn created is moved to the user's configured trash (never hard-deleted, so an accidental revert is itself recoverable); a note it modified is restored to the exact bytes recorded before the first write of the turn, and is re-created if it has since been removed. */
export async function revertVaultEdits(app: App, edits: VaultEdit[]): Promise<RevertOutcome> {
  const reverted: string[] = []
  const failed: string[] = []
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i]!
    try {
      const existing = app.vault.getAbstractFileByPath(edit.path)
      if (existing instanceof TFolder) {
        failed.push(edit.path)
        continue
      }
      if (edit.before === null) {
        if (existing instanceof TFile) await trashVaultFile(app, existing)
      } else if (existing instanceof TFile) {
        await app.vault.modify(existing, edit.before)
      } else {
        await app.vault.create(edit.path, edit.before)
      }
      reverted.push(edit.path)
    } catch {
      failed.push(edit.path)
    }
  }
  return { reverted, failed }
}

async function trashVaultFile(app: App, file: TFile): Promise<void> {
  // FileManager.trashFile honours the user's trash preference (vault .trash vs OS bin) but only landed in Obsidian 1.6.6, while this plugin's minAppVersion is 1.5.0 — so feature-detect it and fall back to the older Vault.trash rather than hard-deleting on an older host.
  const manager = app.fileManager as unknown as { trashFile?: (f: TFile) => Promise<void> }
  if (typeof manager.trashFile === 'function') {
    await manager.trashFile(file)
    return
  }
  await app.vault.trash(file, true)
}

// ---- arg coercion / misc ------------------------------------------------------

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function outside(path: string): ToolResult {
  return err(
    `'${path}' is outside the vault.`,
    'Only paths inside the vault can be accessed; do not use absolute paths or ".." to escape it.'
  )
}

/** Translate a simple file glob ('*.md', 'Folder/**\/*.md') to a RegExp that matches a vault-relative path. Supports `*`, `**`, and `?`. */
function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++ // collapse '**/' into '.*'
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  // A bare glob with no slash ('*.md') should match by basename anywhere.
  const anchored = glob.includes('/') ? `^${re}$` : `(^|/)${re}$`
  return new RegExp(anchored)
}
