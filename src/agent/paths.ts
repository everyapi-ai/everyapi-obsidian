// Pure, host-independent path-confinement logic for the agentic note tools.
//
// Unlike the VS Code agent (which joins onto an absolute workspace root), the Obsidian Vault API is ALREADY vault-scoped: every path it accepts is relative to the vault root, there is no on-disk absolute prefix to reason about. So the guard here is purely lexical: collapse './'..' segments (separator-agnostic), reject absolute paths, and reject anything that escapes the vault root (a normalized path that still starts with '..'). It returns a clean, forward-slash, vault-relative path or null — for clean error messages and a defense-in-depth layer over the Vault API. Host-free so it can be unit-tested.

/** Collapse './'..' segments without touching disk. Treats both '/' and '\\'
 *  as separators so a Windows-style '..\\..\\x' is collapsed like its POSIX form instead of surviving as one literal name (which a later joiner could re-interpret and escape the vault). Leading '..' segments are preserved so
 *  the caller can detect (and reject) an escape. */
export function normalizeVaultPath(p: string): string {
  const unified = p.replace(/\\/g, '/')
  const isAbs = unified.startsWith('/')
  const parts = unified.split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length && stack[stack.length - 1] !== '..') stack.pop()
      else stack.push('..')
    } else {
      stack.push(part)
    }
  }
  return (isAbs ? '/' : '') + stack.join('/')
}

/**
 * Resolve a vault-relative path to a clean, forward-slash, vault-relative form, or return null when it is unsafe:
 *   - empty input            → null (treat as "no path", not the root)
 *   - absolute path ('/…')   → null (vault paths are always relative)
 *   - escapes the vault root → null (normalizes to something starting with '..')
 *
 * '.' (the vault root) normalizes to '' — callers pass '' to the Vault API to mean the root folder.
 */
export function resolveVaultPath(rawPath: string): string | null {
  if (!rawPath) return null
  const unified = rawPath.replace(/\\/g, '/')
  // Reject POSIX absolute paths ('/etc/passwd') and Windows drive-letter absolute paths ('C:/Users/...', from a 'C:\\Users\\...' input already unified above) — both name a location outside the vault.
  if (unified.startsWith('/') || /^[a-zA-Z]:\//.test(unified)) return null
  const normalized = normalizeVaultPath(rawPath)
  if (normalized === '..' || normalized.startsWith('../')) return null
  return normalized
}
