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

/** Count of `<<<<<<< SEARCH` block openers in a diff. `parseDiffBlocks` only
 *  returns blocks that also carry a valid `:start_line:N` line and the full
 *  `-------`/`=======`/`>>>>>>> REPLACE` frame, so any opener missing one of
 *  those is silently skipped. Comparing this count against the parsed count is
 *  how a caller detects malformed blocks that would otherwise be dropped while
 *  the apply still reports success. */
export function countSearchMarkers(diff: string): number {
  return (diff.match(/^<<<<<<< SEARCH[ \t]*$/gm) ?? []).length
}

export interface BlockMatch {
  found: boolean
  index: number
  length: number
  closest?: { from: number; to: number; score: number; text: string }
  /** Set when a match was accepted (or rejected) despite landing far from the
   *  `:start_line:` hint, or when the SEARCH text is ambiguous (occurs more
   *  than once in the file). Surfaces that uncertainty to callers/approval
   *  UIs instead of silently editing whichever copy a plain string search
   *  happened to find first. Absent on the common, unambiguous near-anchor
   *  match, so it never shows up on the normal apply_diff path. */
  warning?: string
}

/** 1-based line number containing byte offset `offset` in `text`. */
function lineNumberAt(text: string, offset: number): number {
  return countNewlines(text.slice(0, offset)) + 1
}

/** Every byte offset in `text` where the literal string `search` occurs. */
function allExactOffsets(text: string, search: string): number[] {
  const offsets: number[] = []
  let at = text.indexOf(search)
  while (at !== -1) {
    offsets.push(at)
    at = text.indexOf(search, at + Math.max(1, search.length))
  }
  return offsets
}

export function locateBlock(text: string, block: DiffBlock): BlockMatch {
  if (block.search === '') {
    return { found: true, index: offsetOfLine(text, block.startLine), length: 0 }
  }
  const window = block.search.split('\n').length

  // Resolve the match by the exact occurrence NEAREST to the :start_line: hint,
  // not the first one an anchored scan happens to reach. When the SEARCH text is
  // unique this is trivially that single copy; when it repeats, nearest-to-hint
  // is what stops the edit from landing on the wrong duplicate — including a
  // duplicate sitting just BEFORE the hint but inside the anchor window, which a
  // first-match-after-anchor search would otherwise pick over the real target.
  const offsets = allExactOffsets(text, block.search)
  if (offsets.length > 0) {
    let best = offsets[0]!
    let bestDistance = Math.abs(lineNumberAt(text, best) - block.startLine)
    for (let i = 1; i < offsets.length; i++) {
      const off = offsets[i]!
      const d = Math.abs(lineNumberAt(text, off) - block.startLine)
      if (d < bestDistance) {
        best = off
        bestDistance = d
      }
    }
    if (bestDistance <= DIFF_BUFFER_LINES) {
      // A distance-0 hit names the intended copy unambiguously (even if the
      // SEARCH text also occurs elsewhere), so it stays warning-free like any
      // clean match. Flag ambiguity only when duplicates exist AND the hint
      // didn't land exactly on one — surfacing which copy proximity picked.
      if (offsets.length > 1 && bestDistance > 0) {
        return {
          found: true,
          index: best,
          length: block.search.length,
          warning: `found ${offsets.length} exact matches of the SEARCH text; selected the one at line ${lineNumberAt(text, best)}, nearest to the given start_line:${block.startLine}`,
        }
      }
      return { found: true, index: best, length: block.search.length }
    }
    if (offsets.length <= 1) {
      // Unambiguous: this is the only place the SEARCH text exists at all,
      // just not where :start_line: said (e.g. a stale hint from an earlier
      // block's line-delta estimate in the same diff). It's still the
      // correct edit target — accept it, but flag the mismatch rather than
      // pretending the hint was accurate.
      return {
        found: true,
        index: best,
        length: block.search.length,
        warning: `matched ${bestDistance} line(s) from the given start_line:${block.startLine} (actual line ${lineNumberAt(text, best)}); the line hint may be stale`,
      }
    }
    // Ambiguous, and none of the copies are near the hint: don't guess which
    // one is intended. Fall through to fuzzy matching for a genuinely
    // different near-hint region (e.g. the real target was edited slightly
    // and no longer matches exactly) — but if fuzzy only rediscovers one of
    // these same exact duplicates, report the ambiguity instead of the
    // generic distance warning below.
  }

  const fz = bestFuzzyWindow(text, block.search, block.startLine)
  if (fz && fz.score >= FUZZY_THRESHOLD) {
    const distance = Math.abs(fz.line + 1 - block.startLine)
    if (distance <= DIFF_BUFFER_LINES) {
      return { found: true, index: fz.index, length: fz.length }
    }
    if (offsets.length > 1) {
      // The fuzzy whole-file fallback just rediscovered one of the ambiguous
      // exact duplicates ruled out above (identical text always scores a
      // perfect 1.0) — don't silently accept it as if it were a confident
      // fuzzy match; report the same ambiguity as a miss instead.
      return {
        found: false,
        index: -1,
        length: 0,
        closest: {
          from: fz.line + 1,
          to: fz.line + window,
          score: Math.round(fz.score * 100),
          text: fz.text,
        },
        warning: `found ${offsets.length} exact matches of the SEARCH text, but none within ${DIFF_BUFFER_LINES} lines of the given start_line:${block.startLine}`,
      }
    }
    return {
      found: true,
      index: fz.index,
      length: fz.length,
      warning: `fuzzy-matched (${Math.round(fz.score * 100)}% similar) ${distance} line(s) from the given start_line:${block.startLine} (actual line ${fz.line + 1})`,
    }
  }

  if (offsets.length > 0) {
    // Exact matches exist, but none of them (nor the fuzzy fallback) landed
    // near the hint — report this as a miss with an explicit ambiguity count
    // instead of silently applying an arbitrary copy.
    return {
      found: false,
      index: -1,
      length: 0,
      closest: {
        from: lineNumberAt(text, offsets[0]!),
        to: lineNumberAt(text, offsets[0]!) + window - 1,
        score: 100,
        text: block.search,
      },
      warning: `found ${offsets.length} exact match(es) of the SEARCH text, but none within ${DIFF_BUFFER_LINES} lines of the given start_line:${block.startLine}`,
    }
  }
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
  | { ok: true; text: string; blocks: number; warnings?: string[] }
  | { ok: false; error: string; suggestion?: string }

export function applyDiff(relPath: string, oldText: string, diff: string): ApplyDiffResult {
  const normalized = diff.replace(/\r\n/g, '\n')
  const blocks = parseDiffBlocks(normalized)
  if (blocks.length === 0) {
    return {
      ok: false,
      error: 'No valid SEARCH/REPLACE blocks found in diff.',
      suggestion:
        'Use the exact format: <<<<<<< SEARCH / :start_line:N / ------- / [search] / ======= / [replace] / >>>>>>> REPLACE',
    }
  }

  // Guard against silently dropping a malformed block: parseDiffBlocks skips any
  // `<<<<<<< SEARCH` opener that lacks `:start_line:N` or a complete frame, so a
  // 3-block diff whose middle block omits the marker would parse to 2 and apply
  // "successfully" with an edit silently missing. Fail loudly instead.
  const markerCount = countSearchMarkers(normalized)
  if (markerCount > blocks.length) {
    const dropped = markerCount - blocks.length
    return {
      ok: false,
      error: `apply_diff parsed only ${blocks.length} of ${markerCount} SEARCH block(s) in ${relPath}; ${dropped} malformed block(s) (missing the ":start_line:N" line or a -------/=======/>>>>>>> REPLACE marker) were dropped.`,
      suggestion:
        'Every block must be exactly: <<<<<<< SEARCH / :start_line:N / ------- / [search] / ======= / [replace] / >>>>>>> REPLACE. Fix the malformed block(s) and retry the full diff.',
    }
  }

  let working = oldText
  let lineDelta = 0
  const warnings: string[] = []
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
        }${match.warning ? `\n${match.warning}` : ''}`,
        suggestion:
          'Re-read the file to get the exact current content and line numbers, then retry with corrected SEARCH text.',
      }
    }
    if (match.warning) warnings.push(`block ${bi + 1}: ${match.warning}`)
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

  return {
    ok: true,
    text: working,
    blocks: blocks.length,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/**
 * An approval preview: `text` is what gets rendered to the user, `truncated`
 * says whether `text` omits part of the real content/diff — the caller MUST
 * surface `truncated` distinctly (not just as trailing text the user can
 * scroll past), because on approval the FULL, untruncated content/diff is
 * what actually gets written, not the preview.
 */
export interface PreviewResult {
  text: string
  truncated: boolean
}

export function previewNewFile(content: string): PreviewResult {
  const lines = content.split('\n')
  const head = lines.slice(0, 40)
  const body = head.map((l) => `+${l}`).join('\n')
  const truncated = lines.length > 40
  const more = truncated ? `\n…(${lines.length - 40} more lines)` : ''
  return { text: body + more, truncated }
}

export function unifiedDiff(relPath: string, oldText: string, newText: string): PreviewResult {
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
  const truncated = text.length > 4000
  return { text: truncated ? text.slice(0, 4000) + '\n…(diff truncated)' : text, truncated }
}
