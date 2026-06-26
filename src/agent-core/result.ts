export type ToolResult =
  | { status: 'ok'; output: string }
  | { status: 'error'; error: string; suggestion?: string }
  | { status: 'denied'; error: string; suggestion?: string }

export const ok = (output: string): ToolResult => ({ status: 'ok', output })

export const err = (error: string, suggestion?: string): ToolResult => ({
  status: 'error',
  error,
  ...(suggestion ? { suggestion } : {}),
})

export const denied = (suggestion: string): ToolResult => ({
  status: 'denied',
  error: 'User declined this action.',
  suggestion,
})

export function resultToString(r: ToolResult): string {
  return JSON.stringify(r)
}
