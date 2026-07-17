// Pure, Obsidian-free helpers extracted from view.ts so they can be unit tested without the Obsidian runtime (which isn't importable under Vitest).

/** Human-readable token count: 1.5M, 200.0k, 842. */
export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/** Cap note content attached as context, marking it when truncated. */
export function truncateNote(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return `${content.slice(0, maxChars)}\n…(note truncated)`
}

export interface HistoryItem {
  role: 'user' | 'assistant'
  content: string
}

/** Keep the most recent messages whose cumulative content length stays within [maxChars], walking newest→oldest then restoring chronological order. This sits on top of the count cap so a few very long turns can't blow a small model's context window. Always keeps at least the newest item, even if it alone exceeds the budget (dropping it would send an empty conversation). */
export function trimHistoryByChars(items: HistoryItem[], maxChars: number): HistoryItem[] {
  const kept: HistoryItem[] = []
  let total = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    total += item.content.length
    if (kept.length > 0 && total > maxChars) break
    kept.push(item)
  }
  return kept.reverse()
}

/** Render text as a markdown blockquote (used by "append as quote"). */
export function toBlockquote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
}
