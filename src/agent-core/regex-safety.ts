// Pure, host-independent guard against pathological search_text patterns.
//
// 'pattern' is a model-controlled tool argument, and the model itself can be steered by untrusted content ingested during the session — file/note content, fetched web pages, MCP tool results (see each host's executors.ts for its specific threat model). Every current host (Obsidian's Electron renderer, VS Code's Node.js extension host) runs the search on a single thread with no way to interrupt a synchronous RegExp.test() call mid-flight, so a catastrophic-backtracking regex handed to `new RegExp(pattern)` and run against file text can freeze the whole process with no way for the user to cancel it.
//
// This is a cheap, dependency-free heuristic, not a full NFA ambiguity analysis. It catches the two dominant "evil regex" shapes — a quantified group whose own body already contains a quantifier (`(a+)+`, `(.*)+`, `(a*){2,}`), and a quantified group whose top-level alternatives overlap (`(a|a)+`, `(a|ab)+`, `(\w|\d)+`) — and caps pattern length. It still does not catch every ReDoS shape (e.g. overlap buried inside a character class or across multi-atom branches like `(ab|a[bc])+`); a runtime step/time budget on the match itself remains the only complete defense. Host-free so it can be unit-tested without any editor runtime and reused by every TypeScript client.

/** Reject patterns longer than this outright — a bound on how much structure a single call can pack in, independent of the nested-quantifier check. */
export const SEARCH_PATTERN_MAX_LENGTH = 200

/** Return a human-readable reason the pattern is unsafe to compile/run, or null when it looks fine. Checked BEFORE `new RegExp(pattern)`. */
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
  if (hasSequentialQuantifierAmbiguity(pattern)) {
    return (
      'Pattern looks like it can cause catastrophic backtracking: adjacent ' +
      'unbounded quantifiers over overlapping characters followed by a required ' +
      'atom (e.g. "a*a*a*c").'
    )
  }
  return null
}

/** Detects the classic nested-quantifier "evil regex" shape: a group `(...)` whose body contains a quantifier (`+`, `*`, or `{`) and which is itself immediately followed by a quantifier, e.g. `(a+)+`, `(.*)+`, `(a*){2,}`. Walks the pattern once, tracking paren depth and character-class state (so parens/quantifier chars inside `[...]` are treated as literals, not structure) and escapes (so `\\+`, `\\(` etc. never count). */
// Inner-quantifier levels tracked per group depth. The distinction matters under a BOUNDED-variable outer interval: a bounded inner ((a{1,3}){2,4}) caps the ambiguity at (width choices)^m — constant in input length — while an unbounded inner ((a*){2,8}) lets the path count grow with the input (~L^m), so only the latter is evil under a small bounded outer.
const INNER_NONE = 0
const INNER_BOUNDED = 1
const INNER_UNBOUNDED = 2

export function hasNestedQuantifier(source: string): boolean {
  let depth = 0
  let inClass = false
  const sawQuantifierAtDepth: number[] = []

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
      sawQuantifierAtDepth[depth] = INNER_NONE
      continue
    }
    if (c === ')') {
      const sawInner = depth > 0 ? (sawQuantifierAtDepth[depth] ?? INNER_NONE) : INNER_NONE
      if (depth > 0) sawQuantifierAtDepth.length = depth
      depth = Math.max(0, depth - 1)
      // A group that (transitively) contains a quantifier makes its enclosing group count as containing one too, so an extra grouping level cannot hide a nested quantifier — e.g. `((a+))+`, `(?:(a+))+`, `((a+)x)+`.
      if (sawInner !== INNER_NONE && depth > 0) {
        sawQuantifierAtDepth[depth] = Math.max(sawQuantifierAtDepth[depth] ?? INNER_NONE, sawInner)
      }
      // How evil the outer quantifier is depends on both sides (uses the same quantifierAt parse as the alternation check so both stay consistent):
      // - unbounded outer (`+`, `*`, `{n,}`): catastrophic over ANY variable inner — `(a+)+`, `(a{1,3})+` all have input-length-many split points;
      // - bounded-variable outer `{n,m}`: with an UNBOUNDED inner the path count still grows with the input (`(a*){2,8}` ~ L^8); with a bounded inner it is capped at (width choices)^m, so only an m past SMALL_BOUNDED_REPEAT_MAX is evil (`(a{1,3}){2,4}` ≤ 3^4 = 81 paths — safe; `(a+){2,30}` and `(a{1,3}){2,30}` are not);
      // - fixed outer `{n}`/`{n,n}`: over a linear/bounded inner it expands to a linear string, but over an UNBOUNDED inner it is n back-to-back unbounded quantifiers (`(.*a){50}` ≡ `.*a.*a…`) whose cost is ~L^n, so a large n backtracks catastrophically — flag it past the same SMALL_BOUNDED_REPEAT_MAX cap used for a variable interval (a small fixed count like `(a+){2}` stays linear-enough and is left alone).
      if (sawInner !== INNER_NONE) {
        const q = quantifierAt(source, i + 1)
        if (q) {
          if (q.max === null) return true
          if (q.max > q.min && (sawInner === INNER_UNBOUNDED || q.max > SMALL_BOUNDED_REPEAT_MAX)) {
            return true
          }
          if (q.max === q.min && sawInner === INNER_UNBOUNDED && q.min > SMALL_BOUNDED_REPEAT_MAX) {
            return true
          }
        }
      }
      continue
    }
    if (depth > 0) {
      if (c === '+' || c === '*') {
        sawQuantifierAtDepth[depth] = INNER_UNBOUNDED
      } else if (c === '{') {
        // An interval counts as an inner quantifier when its width can VARY: `{n,}` (open-ended, unbounded) and `{n,m}` with m > n (bounded) both let each iteration of the enclosing group consume a different amount. Only a fixed-count `{n}` (or degenerate `{n,n}`) expands to a linear string and counts for nothing (`(a{3})+` is safe), and a `{` that is not a valid interval is a literal.
        const q = quantifierAt(source, i)
        if (q) {
          if (q.max === null) {
            sawQuantifierAtDepth[depth] = INNER_UNBOUNDED
          } else if (q.max > q.min) {
            sawQuantifierAtDepth[depth] = Math.max(
              sawQuantifierAtDepth[depth] ?? INNER_NONE,
              INNER_BOUNDED
            )
          }
          i = q.end // skip the interval body
        }
      }
    }
  }
  return false
}

/** Detects the alternation-overlap "evil regex" shape that hasNestedQuantifier can't see: a group repeated by a VARIABLE quantifier (`+`, `*`, `{n,}`, or `{n,m}` with m > n) whose top-level alternatives can match the same input, so the engine has exponentially many ways to split a run — e.g. `(a|a)+`, `(a|ab)+`, `(\w|\d)+`, `(.|x)*`, `(a|a){2,50}`. Two alternatives "overlap" when one is empty, they are identical, one is a string-prefix of the other, or (for single-atom alternatives) their character sets intersect. Truly disjoint alternations like `(foo|bar)+`, `(foo|flu)+`, or `(\d|\s)+` are NOT flagged; an unquantified/fixed-count group (`(a|a)`, `(a|a){2}`) is safe and ignored, as is a small bounded repeat (`(a|a){2,4}` — at most SMALL_BOUNDED_REPEAT_MAX ambiguous iterations, a constant a backtracking engine shrugs off). Like hasNestedQuantifier, a cheap heuristic: it does not chase overlap hidden inside a character class or across multi-atom branches (`(ab|a[bc])+`). */
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
      const q = quantifierAt(source, i + 1)
      if (!q) continue
      // Fixed-count repetition is never evil, and a bounded repeat up to SMALL_BOUNDED_REPEAT_MAX caps the ambiguity at (branches)^m — `(a|a){2,4}` is at most 16 paths. Unbounded (`+`, `*`, `{n,}`) or large bounded (`(a|a){2,50}` = 2^50) repeats stay flagged.
      if (q.max !== null && (q.max === q.min || q.max <= SMALL_BOUNDED_REPEAT_MAX)) continue
      const inner = unwrapWholeGroups(source.slice(open + 1, i))
      const branches = topLevelBranches(inner)
      if (branches.length >= 2 && branchesOverlap(branches)) return true
    }
  }
  return false
}

/**
 * Detects the ungrouped sequential-quantifier "evil regex" shape neither guard above can see: a run of two or more ADJACENT single atoms, each carrying an UNBOUNDED quantifier (`*`, `+`, or `{n,}`), whose character sets overlap AND that is followed by a REQUIRED atom which can fail — e.g. `a*a*a*…c`, `\w*\d*x`. The overlap lets a run of matching text be partitioned between the neighbouring quantifiers in input-length-many ways, and the failing required suffix forces the engine to try them all, driving quadratic-to-exponential backtracking with no group in sight.
 *
 * To avoid false positives on genuinely linear-time patterns, three shapes are deliberately NOT flagged:
 * - a nullable/absent tail (`\w*\d*`, `.*\s*`, `a*a*` at end): with nothing required after the run the engine matches greedily and never backtracks;
 * - BOUNDED intervals (`\w{1,3}\d{1,3}`, `a{1,2}a{1,2}`): a `{n,m}` caps the split count at a constant, so the run stays linear — mirroring the sibling guards' SMALL_BOUNDED_REPEAT_MAX exemption (only unbounded atoms enter a run);
 * - disjoint neighbours (`\s*\d*`, `\d+\.\d+`): non-overlapping atoms can't share a run. `?` is not a quantifier here, and atoms with more structure (`[...]` classes, `(...)` groups) break the run rather than being analysed — a cheap heuristic.
 */
export function hasSequentialQuantifierAmbiguity(source: string): boolean {
  // Source of the preceding UNBOUNDED-quantified atom while an overlapping run continues; null when the run is broken.
  let prevAtom: string | null = null
  // Length of the current run of adjacent overlapping unbounded-quantified atoms (>=2 means a partition-ambiguous run has formed).
  let run = 0
  let i = 0
  while (i < source.length) {
    const { src, end } = readAtom(source, i)
    const q = quantifierAt(source, end)
    // Only UNBOUNDED quantifiers create input-length-many partitions; a bounded `{n,m}` (max !== null) caps them at a constant and stays linear.
    const unbounded = !!q && q.max === null
    if (src !== null && unbounded) {
      run = prevAtom !== null && atomsOverlap(prevAtom, src) ? run + 1 : 1
      prevAtom = src
    } else {
      // The run ended. It only backtracks catastrophically when a REQUIRED atom (min repetition >= 1) follows and can fail, forcing every partition to be retried; a nullable/absent tail matches greedily in linear time.
      if (run >= 2 && src !== null && (!q || q.min >= 1)) return true
      run = 0
      prevAtom = null
    }
    i = q ? q.end + 1 : end
  }
  return false
}

/** Read one regex atom starting at `i` (before any quantifier). Returns the atom's source string ONLY for the single-atom shapes atomPredicate models (a literal char, an escape `\x`, or `.`); `src` is null for classes, groups and structural chars — which advance the cursor past the whole construct so a run's adjacency can't be misread from a group/class interior. `end` is the index just past the atom. */
function readAtom(source: string, i: number): { src: string | null; end: number } {
  const c = source[i]!
  if (c === '\\') return { src: source.slice(i, i + 2), end: i + 2 }
  if (c === '[') {
    // Character class — skip to the matching `]`, honouring a leading `^`/`]` and escapes. Not a single atom this heuristic models.
    let j = i + 1
    if (source[j] === '^') j++
    if (source[j] === ']') j++ // a `]` right after `[`/`[^` is a literal
    while (j < source.length && source[j] !== ']') {
      if (source[j] === '\\') j++
      j++
    }
    return { src: null, end: j < source.length ? j + 1 : j }
  }
  if (c === '(') {
    const close = closingParenAt(source, i)
    return { src: null, end: close === -1 ? source.length : close + 1 }
  }
  if (c === '.') return { src: '.', end: i + 1 }
  if (!METACHARS.includes(c)) return { src: c, end: i + 1 }
  return { src: null, end: i + 1 } // structural/quantifier char with no atom
}

interface Quantifier {
  min: number
  /** null = unbounded (`+`, `*`, or an open-ended `{n,}`). */
  max: number | null
  /** Index of the quantifier's last character (`+`/`*` itself, or the `}`). */
  end: number
}

/** Ambiguity multiplier cap for a bounded-variable interval `{n,m}`: repeated ambiguity costs (choices)^m paths — a constant independent of input length — so a small m cannot freeze the engine ((a|a){2,4} ≤ 16 paths, (a{1,3}){2,4} ≤ 81) while a large one is astronomical ((a|a){2,50} = 2^50, which locks an engine at ~40 chars of input). 8 keeps the worst practical constant in the thousands. */
const SMALL_BOUNDED_REPEAT_MAX = 8

/** Parse the quantifier starting at position `i`: `+`, `*`, or a `{n}` / `{n,}` / `{n,m}` interval. Returns null when `i` starts no quantifier (including a `{` that is not a valid interval — that's a literal). The single quantifier grammar shared by hasNestedQuantifier and hasOverlappingAlternation, so the two guards can never disagree about what an interval means. */
function quantifierAt(source: string, i: number): Quantifier | null {
  const c = source[i]
  if (c === '+' || c === '*') return { min: 0, max: null, end: i }
  if (c !== '{') return null
  const close = source.indexOf('}', i + 1)
  if (close === -1) return null
  const interval = /^(\d+)(?:,(\d*))?$/.exec(source.slice(i + 1, close))
  if (!interval) return null
  const [, minStr, maxStr] = interval
  const min = Number(minStr)
  const max = maxStr === undefined ? min : maxStr === '' ? null : Number(maxStr)
  return { min, max, end: close }
}

/** Peel redundant wrapper groups that span the WHOLE body — `((a|a))+` backtracks exactly like `(a|a)+`, but the outer group's body has no top-level `|`, so without unwrapping the alternation hides one level down and the guard is trivially bypassed. Partial-span groups (`(x(a|a))+`) are left alone — multi-atom branch analysis is out of scope by design. */
function unwrapWholeGroups(inner: string): string {
  let body = stripGroupPrefix(inner)
  while (body.startsWith('(') && closingParenAt(body, 0) === body.length - 1) {
    body = stripGroupPrefix(body.slice(1, -1))
  }
  return body
}

/** Index of the `)` closing the `(` at `open`, or -1 when unbalanced. Tracks escapes and character classes like the other walkers here. */
function closingParenAt(source: string, open: number): number {
  let depth = 0
  let inClass = false
  for (let i = open; i < source.length; i++) {
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
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Strip a leading group modifier (`?:`, `?=`, `?!`, `?<=`, `?<!`, `?<name>`) so the branch analysis sees only the alternation body. */
function stripGroupPrefix(inner: string): string {
  if (inner.startsWith('?:') || inner.startsWith('?=') || inner.startsWith('?!')) {
    return inner.slice(2)
  }
  if (inner.startsWith('?<=') || inner.startsWith('?<!')) return inner.slice(3)
  const named = /^\?<[A-Za-z_$][\w$]*>/.exec(inner)
  return named ? inner.slice(named[0].length) : inner
}

/** Split on top-level `|` only (ignores `|` inside nested groups, classes, or escapes). */
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
  // A literal string-prefix relationship (`a` vs `ab`) always creates an ambiguous split when the group is repeated.
  if (a.startsWith(b) || b.startsWith(a)) return true
  return atomsOverlap(a, b)
}

interface Atom {
  test: (c: string) => boolean
  literal: string | null
}

const METACHARS = '\\^$.|?*+()[]{}'

/** Interpret a branch that is a single atom (one literal char, an escaped literal, a `\d\D\w\W\s\S` shorthand, or `.`) as a character-set predicate; null for anything with more structure (multi-atom, a `[...]` class, groups), which this heuristic does not analyse. */
function atomPredicate(s: string): Atom | null {
  // `.` does NOT match line terminators (patterns compile without the `s` flag), so `(.|\n)*` — the standard "any char including newline" idiom — has genuinely disjoint branches and must not be flagged as overlapping.
  if (s === '.') {
    return {
      test: (c) => c !== '\n' && c !== '\r' && c !== '\u2028' && c !== '\u2029',
      literal: null,
    }
  }
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
      // Control-character escapes denote the control char itself, not the letter after the backslash — `\n` is a newline, not a literal 'n' (treating it as 'n' made `.` overlap it and mis-flagged `(.|\n)*`).
      case 'n':
        return { test: (c) => c === '\n', literal: '\n' }
      case 'r':
        return { test: (c) => c === '\r', literal: '\r' }
      case 't':
        return { test: (c) => c === '\t', literal: '\t' }
      case 'f':
        return { test: (c) => c === '\f', literal: '\f' }
      case 'v':
        return { test: (c) => c === '\v', literal: '\v' }
      case '0':
        return { test: (c) => c === '\0', literal: '\0' }
      default:
        return { test: (c) => c === e, literal: e } // escaped literal, e.g. \. \+ \/
    }
  }
  return null
}

/** Whether two single-atom alternatives share any character (so the alternation is ambiguous). Probes a fixed spread of characters plus each atom's own literal, so `(\w|\d)` and `(\w|q)` are caught while `(a|b)` and `(\d|\s)` are not. */
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
