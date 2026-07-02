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
// analysis: it catches the dominant "evil regex" shape (a quantified group
// whose own body already contains a quantifier, e.g. `(a+)+`, `(.*)+`,
// `(a*){2,}`) and caps pattern length, but it does not catch every ReDoS
// shape (e.g. overlapping alternation like `(a|a)+`, which has no nested
// quantifier to detect). Host-free so it can be unit-tested without any
// editor runtime and reused by every TypeScript client.

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
      const next = source[i + 1]
      const nextIsQuantifier = next === '+' || next === '*' || next === '{'
      if (sawInner && nextIsQuantifier) return true
      continue
    }
    if ((c === '+' || c === '*' || c === '{') && depth > 0) {
      sawQuantifierAtDepth[depth] = true
    }
  }
  return false
}
