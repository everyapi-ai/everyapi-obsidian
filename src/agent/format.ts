// Pure read_file line-numbering / windowing, extracted so it can be unit-tested
// without the Obsidian runtime. `executors.ts` reads the note via the Vault API
// and delegates the 1-based offset/limit windowing and `<lineno>\t<text>`
// rendering to here. (Mirrors apps/vscode/src/agent/format.ts.)

const READ_DEFAULT_LINES = 2000
const READ_MAX_LINES = 2000
const LINE_MAX_CHARS = 2000

export type NumberedResult =
  | { ok: true; text: string }
  | { ok: false; error: string; suggestion?: string }

/**
 * Render `text` as a numbered window. `offset` is the 1-based first line and
 * `limit` the max line count (both clamped to sane bounds). Returns the
 * `File: …` header + `<n>\t<line>` body, with a trailing "more lines" hint when
 * the window does not reach EOF. Errors (offset past EOF) come back structured.
 */
export function formatNumberedLines(
  relPath: string,
  text: string,
  offset?: number,
  limit?: number,
): NumberedResult {
  const lines = text.split('\n')
  const start = Math.max(1, offset ?? 1)
  const count = Math.min(Math.max(1, limit ?? READ_DEFAULT_LINES), READ_MAX_LINES)
  if (start > lines.length) {
    return {
      ok: false,
      error: `offset ${start} is past end of file (${lines.length} lines).`,
      suggestion: 'Read from an offset within the file.',
    }
  }
  const end = Math.min(start - 1 + count, lines.length)
  const width = String(end).length
  const body = lines
    .slice(start - 1, end)
    .map((line, i) => {
      const n = start + i
      const clipped =
        line.length > LINE_MAX_CHARS ? line.slice(0, LINE_MAX_CHARS) + ' …(line truncated)' : line
      return `${String(n).padStart(width)}\t${clipped}`
    })
    .join('\n')
  const more =
    end < lines.length
      ? `\n…(${lines.length - end} more lines; call read_file again with offset=${end + 1})`
      : ''
  return { ok: true, text: `File: ${relPath} (lines ${start}-${end} of ${lines.length})\n${body}${more}` }
}
