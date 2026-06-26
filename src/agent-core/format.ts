const READ_DEFAULT_LINES = 2000
const READ_MAX_LINES = 2000
const READ_MAX_LINE_CHARS = 2000

export type ReadFormatResult =
  | { ok: true; text: string }
  | { ok: false; error: string; suggestion?: string }

export function formatNumberedLines(
  relPath: string,
  content: string,
  offset = 1,
  limit = READ_DEFAULT_LINES,
): ReadFormatResult {
  const lines = content.split(/\r?\n/)
  const start = Math.max(1, Math.floor(offset || 1))
  const take = Math.min(READ_MAX_LINES, Math.max(1, Math.floor(limit || READ_DEFAULT_LINES)))
  if (start > lines.length) {
    return {
      ok: false,
      error: `offset ${start} is past end of file (${lines.length} lines).`,
      suggestion: 'Read from an offset within the file.',
    }
  }
  const end = Math.min(lines.length, start + take - 1)
  const width = String(end).length
  const body = lines
    .slice(start - 1, end)
    .map((line, i) => {
      const no = String(start + i).padStart(width, ' ')
      const clipped =
        line.length > READ_MAX_LINE_CHARS
          ? line.slice(0, READ_MAX_LINE_CHARS) + ' …(line truncated)'
          : line
      return `${no}\t${clipped}`
    })
    .join('\n')
  const more =
    end < lines.length
      ? `\n…(${lines.length - end} more lines; call read_file again with offset=${end + 1})`
      : ''
  return { ok: true, text: `File: ${relPath} (lines ${start}-${end} of ${lines.length})\n${body}${more}` }
}

export interface DiffStat {
  added: number
  removed: number
}

export function diffStat(oldText: string, newText: string): DiffStat {
  const oldLines = oldText === '' ? [] : oldText.split('\n')
  const newLines = newText === '' ? [] : newText.split('\n')
  const m = oldLines.length
  const n = newLines.length
  const [rows, cols] = m <= n ? [newLines, oldLines] : [oldLines, newLines]
  const span = cols.length
  let prev = Array.from<number>({ length: span + 1 }).fill(0)
  let cur = Array.from<number>({ length: span + 1 }).fill(0)
  for (let i = 1; i <= rows.length; i++) {
    for (let j = 1; j <= span; j++) {
      cur[j] = rows[i - 1] === cols[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!)
    }
    const t = prev
    prev = cur
    cur = t
  }
  const common = prev[span]!
  return { added: n - common, removed: m - common }
}

export function formatDiffStat({ added, removed }: DiffStat): string {
  if (added === 0 && removed === 0) return '±0'
  const parts: string[] = []
  if (added > 0) parts.push(`+${added}`)
  if (removed > 0) parts.push(`-${removed}`)
  return parts.join(' ')
}
