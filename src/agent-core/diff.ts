import { linesTrimEqual, offsetOfLine } from './edit'

const FUZZY_THRESHOLD = 0.9
const DIFF_BUFFER_LINES = 40
const FUZZY_MAX_LINES = 6000

export interface DiffBlock {
  startLine: number
  search: string
  replace: string
}

const SEARCH_RE =
  /<<<<<<< SEARCH\s*\n:start_line:\s*(\d+)\s*\n-------\s*\n([\s\S]*?)\n?=======\s*\n([\s\S]*?)\n?>>>>>>> REPLACE/g

export function parseDiffBlocks(diff: string): DiffBlock[] {
  const blocks: DiffBlock[] = []
  SEARCH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SEARCH_RE.exec(diff)) !== null) {
    blocks.push({ startLine: Number(m[1]), search: m[2]!, replace: m[3]! })
  }
  return blocks
}

export interface BlockMatch {
  found: boolean
  index: number
  length: number
  closest?: { from: number; to: number; score: number; text: string }
}

export function locateBlock(text: string, block: DiffBlock): BlockMatch {
  if (block.search === '') {
    return { found: true, index: offsetOfLine(text, block.startLine), length: 0 }
  }
  const anchor = offsetOfLine(text, Math.max(1, block.startLine - DIFF_BUFFER_LINES))
  let at = text.indexOf(block.search, anchor)
  if (at === -1) at = text.indexOf(block.search)
  if (at !== -1) return { found: true, index: at, length: block.search.length }
  const fz = bestFuzzyWindow(text, block.search, block.startLine)
  if (fz && fz.score >= FUZZY_THRESHOLD) return { found: true, index: fz.index, length: fz.length }
  const window = block.search.split('\n').length
  return {
    found: false,
    index: -1,
    length: 0,
    closest: fz
      ? {
          from: fz.line + 1,
          to: fz.line + window,
          score: Math.round(fz.score * 100),
          text: fz.text,
        }
      : undefined,
  }
}

export function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++
  return n
}

interface FuzzyWindow {
  index: number
  length: number
  line: number
  score: number
  text: string
}

export function bestFuzzyWindow(
  text: string,
  search: string,
  startLine: number
): FuzzyWindow | null {
  const lines = text.split('\n')
  const searchLines = search.split('\n')
  const window = searchLines.length
  if (window > lines.length) return null
  const scan = (from: number, to: number): FuzzyWindow | null => {
    let best: FuzzyWindow | null = null
    const last = Math.min(to, lines.length - window)
    for (let i = Math.max(0, from); i <= last; i++) {
      const start = offsetOfLine(text, i + 1)
      const chunk = lines.slice(i, i + window).join('\n')
      if (linesTrimEqual(lines, i, searchLines))
        return { index: start, length: chunk.length, line: i, score: 1, text: chunk }
      const score = similarity(chunk, search)
      if (!best || score > best.score) {
        best = { index: start, length: chunk.length, line: i, score, text: chunk }
        if (score >= 0.99) return best
      }
    }
    return best
  }
  const anchor = Math.max(0, startLine - 1)
  const near = scan(anchor - DIFF_BUFFER_LINES, anchor + window + DIFF_BUFFER_LINES)
  if (near && near.score >= FUZZY_THRESHOLD) return near
  if (lines.length > FUZZY_MAX_LINES) return near
  const whole = scan(0, lines.length)
  if (!near) return whole
  if (!whole) return near
  return whole.score > near.score ? whole : near
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length)
}

export function levenshtein(a: string, b: string): number {
  const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let cur = Array.from<number>({ length: n + 1 })
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost)
    }
    const t = prev
    prev = cur
    cur = t
  }
  return prev[n]!
}

export type ApplyDiffResult =
  | { ok: true; text: string; blocks: number }
  | { ok: false; error: string; suggestion?: string }

export function applyDiff(relPath: string, oldText: string, diff: string): ApplyDiffResult {
  const blocks = parseDiffBlocks(diff.replace(/\r\n/g, '\n'))
  if (blocks.length === 0) {
    return {
      ok: false,
      error: 'No valid SEARCH/REPLACE blocks found in diff.',
      suggestion:
        'Use the exact format: <<<<<<< SEARCH / :start_line:N / ------- / [search] / ======= / [replace] / >>>>>>> REPLACE',
    }
  }

  let working = oldText
  let lineDelta = 0
  for (let bi = 0; bi < blocks.length; bi++) {
    const raw = blocks[bi]!
    const block =
      lineDelta !== 0 ? { ...raw, startLine: Math.max(1, raw.startLine + lineDelta) } : raw
    const match = locateBlock(working, block)
    if (!match.found) {
      return {
        ok: false,
        error: `apply_diff block ${bi + 1} did not match ${relPath} at/near line ${block.startLine}.${
          match.closest
            ? `\nClosest region (lines ${match.closest.from}-${match.closest.to}, ${match.closest.score}% similar):\n${match.closest.text}`
            : ''
        }`,
        suggestion:
          'Re-read the file to get the exact current content and line numbers, then retry with corrected SEARCH text.',
      }
    }
    working =
      working.slice(0, match.index) + block.replace + working.slice(match.index + match.length)
    lineDelta += countNewlines(raw.replace) - countNewlines(raw.search)
  }

  if (working === oldText) {
    return {
      ok: false,
      error: 'Diff produced no change.',
      suggestion: 'The SEARCH and REPLACE content are identical; adjust the edit.',
    }
  }

  return { ok: true, text: working, blocks: blocks.length }
}

export function previewNewFile(content: string): string {
  const lines = content.split('\n')
  const head = lines.slice(0, 40)
  const body = head.map((l) => `+${l}`).join('\n')
  const more = lines.length > 40 ? `\n…(${lines.length - 40} more lines)` : ''
  return body + more
}

export function unifiedDiff(relPath: string, oldText: string, newText: string): string {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  const ctx = 2
  const ctxStart = Math.max(0, start - ctx)
  const lines: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`]
  for (let i = ctxStart; i < start; i++) lines.push(` ${a[i]}`)
  for (let i = start; i <= endA; i++) lines.push(`-${a[i]}`)
  for (let i = start; i <= endB; i++) lines.push(`+${b[i]}`)
  const ctxEnd = Math.min(a.length - 1, endA + ctx)
  for (let i = endA + 1; i <= ctxEnd; i++) lines.push(` ${a[i]}`)
  const text = lines.join('\n')
  return text.length > 4000 ? text.slice(0, 4000) + '\n…(diff truncated)' : text
}
