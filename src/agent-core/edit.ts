export function offsetOfLine(text: string, line1Based: number): number {
  if (line1Based <= 1) return 0
  let offset = 0
  let line = 1
  while (line < line1Based) {
    const nl = text.indexOf('\n', offset)
    if (nl === -1) return text.length
    offset = nl + 1
    line++
  }
  return offset
}

export function linesTrimEqual(lines: string[], at: number, searchLines: string[]): boolean {
  for (let j = 0; j < searchLines.length; j++) {
    if (lines[at + j]!.replace(/\s+$/, '') !== searchLines[j]!.replace(/\s+$/, '')) return false
  }
  return true
}

interface Occurrence {
  index: number
  length: number
}

function locateAllOccurrences(text: string, search: string): Occurrence[] {
  const occ: Occurrence[] = []
  if (search === '') return occ
  let at = text.indexOf(search)
  while (at !== -1) {
    occ.push({ index: at, length: search.length })
    at = text.indexOf(search, at + Math.max(1, search.length))
  }
  if (occ.length > 0) return occ

  const lines = text.split('\n')
  const searchLines = search.split('\n')
  const window = searchLines.length
  if (window > lines.length) return occ
  for (let i = 0; i <= lines.length - window; i++) {
    if (!linesTrimEqual(lines, i, searchLines)) continue
    const index = offsetOfLine(text, i + 1)
    const chunk = lines.slice(i, i + window).join('\n')
    occ.push({ index, length: chunk.length })
    i += window - 1
  }
  return occ
}

export function replaceAllOccurrences(
  text: string,
  search: string,
  replace: string,
): { text: string; count: number } {
  const all = locateAllOccurrences(text, search)
  let out = text
  for (let k = all.length - 1; k >= 0; k--) {
    const occ = all[k]!
    out = out.slice(0, occ.index) + replace + out.slice(occ.index + occ.length)
  }
  return { text: out, count: all.length }
}

export function insertAtLine(
  text: string,
  line: number,
  content: string,
): { ok: true; text: string } | { ok: false; lineCount: number } {
  const lineCount = text.length === 0 ? 0 : text.split('\n').length
  if (line > lineCount + 1) return { ok: false, lineCount }
  const at = line === 0 ? text.length : offsetOfLine(text, line)
  return { ok: true, text: text.slice(0, at) + content + text.slice(at) }
}
