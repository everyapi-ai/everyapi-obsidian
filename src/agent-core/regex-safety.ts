// Pure, host-independent guard against pathological search_text patterns.
//
// 'pattern' is a model-controlled tool argument, and the model itself can be
// steered by untrusted content ingested during the session — file/note
// content, fetched web pages, MCP tool results (see each host's
// executors.ts for its specific threat model). Every current host
// (Obsidian's Electron renderer, VS Code's Node.js extension host) runs the
// search on a single thread with no way to interrupt a synchronous
// RegExp.test() call mid-flight, so a catastrophic-backtracking regex handed
// to `new RegExp(pattern)` and run against file text can freeze the whole
// process with no way for the user to cancel it.
//
// This is a cheap, dependency-free heuristic, not a full NFA ambiguity
// analysis. It catches the two dominant "evil regex" shapes — a quantified
// group whose own body already contains a quantifier (`(a+)+`, `(.*)+`,
// `(a*){2,}`), and a quantified group whose top-level alternatives overlap
// (`(a|a)+`, `(a|ab)+`, `(\w|\d)+`) — and caps pattern length. It still does
// not catch every ReDoS shape (e.g. overlap buried inside a character class or
// across multi-atom branches like `(ab|a[bc])+`); a runtime step/time budget on
// the match itself remains the only complete defense. Host-free so it can be
// unit-tested without any editor runtime and reused by every TypeScript client.

/** Reject patterns longer than this outright — a bound on how much structure
 *  a single call can pack in, independent of the nested-quantifier check. */
export const SEARCH_PATTERN_MAX_LENGTH = 200

/**
 * Return a human-readable reason the pattern is unsafe to compile/run, or
 * null when it looks fine. Checked BEFORE `new RegExp(pattern)`.
 */
export function unsafeSearchPatternReason(pattern: string): string | null {
  if (pattern.length > SEARCH_PATTERN_MAX_LENGTH) {
    return `Pattern is too long (${pattern.length} chars; max ${SEARCH_PATTERN_MAX_LENGTH}).`
  }
  if (hasNestedQuantifier(pattern)) {
    return (
      'Pattern looks like it can cause catastrophic backtracking: a repeated ' +
      'group whose own body is also repeated (e.g. "(a+)+" or "(.*)+").'
    )
  }
  if (hasOverlappingAlternation(pattern)) {
    return (
      'Pattern looks like it can cause catastrophic backtracking: a repeated ' +
      'group whose alternatives overlap (e.g. "(a|a)+" or "(\\w|\\d)+").'
    )
  }
  return null
}

/**
 * Detects the classic nested-quantifier "evil regex" shape: a group `(...)`
 * whose body contains a quantifier (`+`, `*`, or `{`) and which is itself
 * immediately followed by a quantifier, e.g. `(a+)+`, `(.*)+`, `(a*){2,}`.
 * Walks the pattern once, tracking paren depth and character-class state
 * (so parens/quantifier chars inside `[...]` are treated as literals, not
 * structure) and escapes (so `\\+`, `\\(` etc. never count).
 */
export function hasNestedQuantifier(source: string): boolean {
  let depth = 0
  let inClass = false
  const sawQuantifierAtDepth: boolean[] = []

  for (let i = 0; i < source.length; i++) {
    const c = source[i]!

    if (c === '\\') {
      i++ // the escaped character is a literal; skip it entirely
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') {
      inClass = true
      continue
    }
    if (c === '(') {
      depth++
      sawQuantifierAtDepth[depth] = false
      continue
    }
    if (c === ')') {
      const sawInner = depth > 0 && (sawQuantifierAtDepth[depth] ?? false)
      if (depth > 0) sawQuantifierAtDepth.length = depth
      depth = Math.max(0, depth - 1)
      // A group that (transitively) contains a quantifier makes its enclosing
      // group count as containing one too, so an extra grouping level cannot
      // hide a nested quantifier — e.g. `((a+))+`, `(?:(a+))+`, `((a+)x)+`.
      if (sawInner && depth > 0) sawQuantifierAtDepth[depth] = true
      const next = source[i + 1]
      const nextIsQuantifier = next === '+' || next === '*' || next === '{'
      if (sawInner && nextIsQuantifier) return true
      continue
    }
    if (depth > 0) {
      if (c === '+' || c === '*') {
        sawQuantifierAtDepth[depth] = true
      } else if (c === '{') {
        // Only an open-ended interval `{n,}` drives catastrophic backtracking
        // when its group is repeated; a fixed-count `{n}`/`{n,m}` has bounded
        // width, so it must not trip the guard (that would falsely reject safe
        // patterns like `(a{3})+`). A `{` that is not a valid interval is a
        // literal and counts for nothing.
        const close = source.indexOf('}', i + 1)
        const body = close === -1 ? '' : source.slice(i + 1, close)
        if (/^\d+,?\d*$/.test(body)) {
          if (/^\d+,$/.test(body)) sawQuantifierAtDepth[depth] = true
          i = close // skip the interval body
        }
      }
    }
  }
  return false
}

/**
 * Detects the alternation-overlap "evil regex" shape that hasNestedQuantifier
 * can't see: a group repeated by an UNBOUNDED quantifier (`+`, `*`, `{n,}`)
 * whose top-level alternatives can match the same input, so the engine has
 * exponentially many ways to split a run — e.g. `(a|a)+`, `(a|ab)+`, `(\w|\d)+`,
 * `(.|x)*`. Two alternatives "overlap" when one is empty, they are identical,
 * one is a string-prefix of the other, or (for single-atom alternatives) their
 * character sets intersect. Truly disjoint alternations like `(foo|bar)+`,
 * `(foo|flu)+`, or `(\d|\s)+` are NOT flagged, and an unquantified/finitely
 * repeated group (`(a|a)`, `(a|a){2}`) is safe and ignored. Like
 * hasNestedQuantifier, a cheap heuristic: it does not chase overlap hidden
 * inside a character class or across multi-atom branches (`(ab|a[bc])+`).
 */
export function hasOverlappingAlternation(source: string): boolean {
  const openStack: number[] = []
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (c === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') {
      inClass = true
      continue
    }
    if (c === '(') {
      openStack.push(i)
      continue
    }
    if (c === ')') {
      const open = openStack.pop()
      if (open === undefined) continue // unbalanced ')' — ignore
      if (!startsUnboundedQuantifier(source, i + 1)) continue
      const inner = stripGroupPrefix(source.slice(open + 1, i))
      const branches = topLevelBranches(inner)
      if (branches.length >= 2 && branchesOverlap(branches)) return true
    }
  }
  return false
}

/** True when position `i` begins an unbounded quantifier: `+`, `*`, or an
 *  open-ended `{n,}` interval. A fixed `{n}`/`{n,m}` repeats finitely and is
 *  not catastrophic, so it does not count. */
function startsUnboundedQuantifier(source: string, i: number): boolean {
  const c = source[i]
  if (c === '+' || c === '*') return true
  if (c === '{') {
    const close = source.indexOf('}', i + 1)
    if (close === -1) return false
    return /^\d+,$/.test(source.slice(i + 1, close))
  }
  return false
}

/** Strip a leading group modifier (`?:`, `?=`, `?!`, `?<=`, `?<!`, `?<name>`)
 *  so the branch analysis sees only the alternation body. */
function stripGroupPrefix(inner: string): string {
  if (inner.startsWith('?:') || inner.startsWith('?=') || inner.startsWith('?!')) {
    return inner.slice(2)
  }
  if (inner.startsWith('?<=') || inner.startsWith('?<!')) return inner.slice(3)
  const named = /^\?<[A-Za-z_$][\w$]*>/.exec(inner)
  return named ? inner.slice(named[0].length) : inner
}

/** Split on top-level `|` only (ignores `|` inside nested groups, classes, or
 *  escapes). */
function topLevelBranches(inner: string): string[] {
  const branches: string[] = []
  let depth = 0
  let inClass = false
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (c === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') {
      inClass = true
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      if (depth > 0) depth--
    } else if (c === '|' && depth === 0) {
      branches.push(inner.slice(start, i))
      start = i + 1
    }
  }
  branches.push(inner.slice(start))
  return branches
}

function branchesOverlap(branches: string[]): boolean {
  for (const b of branches) if (b === '') return true // an empty alternative is nullable
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      if (alternativesOverlap(branches[i]!, branches[j]!)) return true
    }
  }
  return false
}

function alternativesOverlap(a: string, b: string): boolean {
  if (a === b) return true
  // A literal string-prefix relationship (`a` vs `ab`) always creates an
  // ambiguous split when the group is repeated.
  if (a.startsWith(b) || b.startsWith(a)) return true
  return atomsOverlap(a, b)
}

interface Atom {
  test: (c: string) => boolean
  literal: string | null
}

const METACHARS = '\\^$.|?*+()[]{}'

/** Interpret a branch that is a single atom (one literal char, an escaped
 *  literal, a `\d\D\w\W\s\S` shorthand, or `.`) as a character-set predicate;
 *  null for anything with more structure (multi-atom, a `[...]` class, groups),
 *  which this heuristic does not analyse. */
function atomPredicate(s: string): Atom | null {
  if (s === '.') return { test: () => true, literal: null }
  if (s.length === 1 && !METACHARS.includes(s)) return { test: (c) => c === s, literal: s }
  if (s.length === 2 && s[0] === '\\') {
    const e = s[1]!
    switch (e) {
      case 'd':
        return { test: (c) => /[0-9]/.test(c), literal: null }
      case 'D':
        return { test: (c) => /[^0-9]/.test(c), literal: null }
      case 'w':
        return { test: (c) => /[A-Za-z0-9_]/.test(c), literal: null }
      case 'W':
        return { test: (c) => /[^A-Za-z0-9_]/.test(c), literal: null }
      case 's':
        return { test: (c) => /\s/.test(c), literal: null }
      case 'S':
        return { test: (c) => /\S/.test(c), literal: null }
      default:
        return { test: (c) => c === e, literal: e } // escaped literal, e.g. \. \+ \/
    }
  }
  return null
}

/** Whether two single-atom alternatives share any character (so the alternation
 *  is ambiguous). Probes a fixed spread of characters plus each atom's own
 *  literal, so `(\w|\d)` and `(\w|q)` are caught while `(a|b)` and `(\d|\s)` are
 *  not. */
function atomsOverlap(a: string, b: string): boolean {
  const pa = atomPredicate(a)
  const pb = atomPredicate(b)
  if (!pa || !pb) return false
  const chars = ['a', 'A', '0', '9', '_', ' ', '\t', '\n', '!', '/', '-', '.']
  if (pa.literal) chars.push(pa.literal)
  if (pb.literal) chars.push(pb.literal)
  for (const ch of chars) if (pa.test(ch) && pb.test(ch)) return true
  return false
}
