import { linesTrimEqual, offsetOfLine, replaceAllOccurrences } from './edit'

const FUZZY_THRESHOLD = 0.9
const DIFF_BUFFER_LINES = 40
const FUZZY_MAX_LINES = 6000

export interface DiffBlock {
  startLine: number
  search: string
  replace: string
}

// Head of a block — the opener marker through the `:start_line:` token — kept
// in ONE source string shared by SEARCH_RE and countPlausibleSearchOpeners.
// The two MUST accept the same whitespace (`\s*` spans blank lines): a head
// that parseDiffBlocks consumes but the counter doesn't see breaks the
// counter's "can never parse MORE blocks than this" invariant, and the
// malformed-block guard then waves a merged garbage block through.
const OPENER_HEAD_SRC = '<<<<<<< SEARCH\\s*\\n:start_line:'

const SEARCH_RE = new RegExp(
  `${OPENER_HEAD_SRC}\\s*(\\d+)\\s*\\n-------\\s*\\n([\\s\\S]*?)\\n?=======\\s*\\n([\\s\\S]*?)\\n?>>>>>>> REPLACE`,
  'g'
)

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

/** Count of `<<<<<<< SEARCH` openers that `parseDiffBlocks` did NOT consume —
 *  i.e. malformed blocks that would be silently dropped by an apply. Unlike
 *  comparing `countSearchMarkers` against the parsed-block count, this does
 *  not misfire when a VALID block's search/replace content itself contains a
 *  raw `<<<<<<< SEARCH` line (editing a file that embeds diff markers — test
 *  fixtures, docs about this very format): those lines sit inside a consumed
 *  span and are payload, not dropped blocks. Expects `\n` line endings
 *  (normalize `\r\n` first, as `parseDiffBlocks` requires anyway). */
function countDroppedSearchMarkers(diff: string): number {
  return countSearchMarkers(diff.replace(SEARCH_RE, ''))
}

/** Openers that begin a plausible block: `<<<<<<< SEARCH` followed by a
 *  `:start_line:` line. Built from OPENER_HEAD_SRC — the exact head SEARCH_RE
 *  parses — so `parseDiffBlocks` can never parse MORE blocks than this;
 *  parsing FEWER means a block with a missing frame marker made the lazy
 *  SEARCH_RE span absorb a neighbouring block — the "merged garbage block"
 *  failure the outside-span count alone cannot see, because both openers land
 *  inside the one consumed span. Deliberately un-anchored like SEARCH_RE, so
 *  payload reproducing the full head sequence still errs toward a loud false
 *  reject over silent corruption. */
const PLAUSIBLE_OPENER_RE = new RegExp(OPENER_HEAD_SRC, 'g')

function countPlausibleSearchOpeners(diff: string): number {
  return (diff.match(PLAUSIBLE_OPENER_RE) ?? []).length
}

/**
 * Guard against `parseDiffBlocks` silently mangling a malformed diff. Two
 * distinct failure shapes are checked, and `null` means the diff is sound:
 *
 * - an opener the regex never consumed (e.g. a block missing its
 *   `:start_line:` line) — that block would be silently skipped while the
 *   rest applied "successfully";
 * - an opener ABSORBED into a neighbouring block's span (a block missing its
 *   `=======` or `>>>>>>> REPLACE` makes the lazy regex run through the next
 *   block), which would apply a merged garbage block — writing literal diff
 *   marker lines into the file — and report success.
 *
 * The one shape this deliberately tolerates: a valid block whose payload
 *  contains a bare `<<<<<<< SEARCH` line NOT followed by `:start_line:`
 * (editing a file that embeds diff markers). Payload that reproduces the full
 * opener+`:start_line:` sequence still trips the absorbed-count — erring
 * toward a loud false reject over silent corruption.
 *
 * Shared by `applyDiff` and the per-host executors that run their own apply
 * loop, so the diagnostics cannot drift between clients.
 */
export function malformedDiffBlocksError(
  normalizedDiff: string,
  parsedCount: number,
  relPath: string
): { error: string; suggestion: string } | null {
  const dropped = countDroppedSearchMarkers(normalizedDiff)
  const absorbed = countPlausibleSearchOpeners(normalizedDiff) - parsedCount
  if (dropped <= 0 && absorbed <= 0) return null
  // The two counts can flag the SAME block (an unconsumed opener that also
  // carries `:start_line:`), so report the larger, not the sum.
  const malformed = Math.max(dropped, absorbed, 1)
  return {
    error: `apply_diff parsed ${parsedCount} SEARCH block(s) in ${relPath} but the diff contains ${malformed} more malformed block(s) (missing the ":start_line:N" line or a -------/=======/>>>>>>> REPLACE marker); applying would silently drop or merge them.`,
    suggestion:
      'Every block must be exactly: <<<<<<< SEARCH / :start_line:N / ------- / [search] / ======= / [replace] / >>>>>>> REPLACE. Fix the malformed block(s) and retry the full diff.',
  }
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
      // The SEARCH text (ignoring trailing whitespace) matched more than one
      // window; bestFuzzyWindow picked the copy nearest the hint. Surface which
      // one — mirroring the exact-match path — unless the hint landed exactly on
      // a copy (distance 0), which is unambiguous and stays warning-free.
      if (fz.duplicates && fz.duplicates > 1 && distance > 0) {
        return {
          found: true,
          index: fz.index,
          length: fz.length,
          warning: `found ${fz.duplicates} near-identical matches of the SEARCH text; selected the one at line ${fz.line + 1}, nearest to the given start_line:${block.startLine}`,
        }
      }
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
  /** How many windows in the scanned range were trim-equal to the SEARCH text
   *  (i.e. exact ignoring trailing whitespace). >1 means the SEARCH is
   *  duplicated, so the caller should surface which copy proximity picked. */
  duplicates?: number
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
  const anchor = Math.max(0, startLine - 1)

  // File-wide count of windows trim-equal to the SEARCH (cheap — no Levenshtein),
  // so the duplicate-ambiguity warning reflects the WHOLE file and not merely
  // whichever sub-range the returned window came from. Without this, a SEARCH
  // duplicated more than DIFF_BUFFER_LINES from the hint would be applied to the
  // near copy with no warning, purely because the far copy fell outside the near
  // scan's range.
  let trimEqualTotal = 0
  const lastWindow = lines.length - window
  for (let i = 0; i <= lastWindow; i++) {
    if (linesTrimEqual(lines, i, searchLines)) trimEqualTotal++
  }

  const scan = (from: number, to: number): FuzzyWindow | null => {
    let best: FuzzyWindow | null = null
    let bestDist = Number.POSITIVE_INFINITY
    // Once any trim-equal (score-1) window is seen, no other window can beat it,
    // so stop paying for similarity()/Levenshtein and only keep scanning the
    // cheap trim-equal windows for the nearest-to-hint tiebreak. This restores
    // the early-out the old `score >= 0.99` return gave, without reintroducing
    // the first-in-iteration-order duplicate bug.
    let foundPerfect = false
    const last = Math.min(to, lines.length - window)
    for (let i = Math.max(0, from); i <= last; i++) {
      const isTrimEqual = linesTrimEqual(lines, i, searchLines)
      if (!isTrimEqual && foundPerfect) continue // can't beat a perfect score
      const chunk = lines.slice(i, i + window).join('\n')
      const score = isTrimEqual ? 1 : similarity(chunk, search)
      if (isTrimEqual) foundPerfect = true
      const dist = Math.abs(i - anchor)
      // Prefer the higher score; among equally-scored windows keep the one
      // NEAREST the start_line hint, so a SEARCH block trim-equal (or ~identical)
      // to several windows edits the copy the caller pointed at rather than the
      // first in iteration order — mirroring the exact-match path above.
      if (!best || score > best.score || (score === best.score && dist < bestDist)) {
        best = {
          index: offsetOfLine(text, i + 1),
          length: chunk.length,
          line: i,
          score,
          text: chunk,
        }
        bestDist = dist
      }
    }
    return best
  }

  const near = scan(anchor - DIFF_BUFFER_LINES, anchor + window + DIFF_BUFFER_LINES)
  let result: FuzzyWindow | null
  if (near && near.score >= FUZZY_THRESHOLD) result = near
  else if (lines.length > FUZZY_MAX_LINES) result = near
  else {
    const whole = scan(0, lines.length)
    result = !near ? whole : !whole ? near : whole.score > near.score ? whole : near
  }
  if (result) result.duplicates = trimEqualTotal
  return result
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

export interface ApplyDiffOptions {
  /** Replace EVERY exact occurrence of each block's SEARCH text (the line
   *  anchor is irrelevant then) instead of the single anchored match — the
   *  `replace_all` mode of the apply_diff tool. An empty-SEARCH insertion
   *  block still takes the anchored path. Lives here rather than in a host's
   *  own copy of the loop so every client applies the mode identically. */
  replaceAll?: boolean
}

export function applyDiff(
  relPath: string,
  oldText: string,
  diff: string,
  opts: ApplyDiffOptions = {}
): ApplyDiffResult {
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

  // Guard against parseDiffBlocks silently mangling a malformed diff (dropped
  // or absorbed blocks) — see malformedDiffBlocksError for the failure shapes.
  const malformed = malformedDiffBlocksError(normalized, blocks.length, relPath)
  if (malformed) {
    return { ok: false, ...malformed }
  }

  let working = oldText
  let lineDelta = 0
  const warnings: string[] = []
  for (let bi = 0; bi < blocks.length; bi++) {
    const raw = blocks[bi]!
    const block =
      lineDelta !== 0 ? { ...raw, startLine: Math.max(1, raw.startLine + lineDelta) } : raw

    if (opts.replaceAll && raw.search !== '') {
      // Replace EVERY exact occurrence of the SEARCH block (CRLF/LF and
      // trailing-whitespace tolerance applied per occurrence). The line
      // anchor is irrelevant here, so don't shift the delta into it.
      const applied = replaceAllOccurrences(working, raw.search, raw.replace)
      if (applied.count === 0) {
        const probe = locateBlock(working, block)
        return {
          ok: false,
          error: `apply_diff block ${bi + 1} (replace_all) found no occurrence of the SEARCH text in ${relPath}.${
            probe.closest
              ? `\nClosest region (lines ${probe.closest.from}-${probe.closest.to}, ${probe.closest.score}% similar):\n${probe.closest.text}`
              : ''
          }${probe.warning ? `\n${probe.warning}` : ''}`,
          suggestion:
            'Re-read the file to get the exact current content, then retry with corrected SEARCH text.',
        }
      }
      working = applied.text
      // Net line shift = (occurrences) × (replace − search) line delta.
      lineDelta += applied.count * (countNewlines(raw.replace) - countNewlines(raw.search))
      continue
    }

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
