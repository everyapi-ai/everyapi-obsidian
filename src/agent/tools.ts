// OpenAI-shaped tool definitions for the EveryAPI agentic NOTES tool set, as it operates over an Obsidian vault. These mirror the canonical contract at
// @everyapi-ai/agent-contract (the single source of truth across EveryAPI agent-capable plugins) and we keep the EXACT contract names — read_file, list_dir, search_text, write_file, apply_diff — for cross-plugin consistency. The descriptions are written for notes ("file" = a vault note/file), and there is NO execute_command: Obsidian has no shell. We ship these in the `tools` field of /v1/chat/completions and rely on the gateway to translate them to each upstream's native tool-use format — the plugin never converts client-side.

import {
  OBSIDIAN_AGENT_TOOL_NAMES,
  policyByToolName,
  type ToolPolicy,
} from '@everyapi-ai/agent-contract'

/** A single OpenAI function tool definition, as sent in the request `tools` array. */
export interface OpenAiTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required: string[]
      additionalProperties: false
    }
  }
}

export const TOOL_NAMES = OBSIDIAN_AGENT_TOOL_NAMES

export type ToolName = (typeof TOOL_NAMES)[number]

/**
 * Per-tool execution policy. `needsApproval` tools MUST get explicit, per-call user approval before running — the gateway does not gate execution.
 */
export const TOOL_POLICY = Object.fromEntries(
  TOOL_NAMES.map((name) => {
    const policy = policyByToolName(name)
    if (!policy) throw new Error(`Missing EveryAPI agent tool policy: ${name}`)
    return [name, policy]
  })
) as Record<ToolName, ToolPolicy>

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name)
}

export const AGENT_TOOLS: OpenAiTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a note or file from the vault and return its contents with 1-based line numbers (useful for diffing and for anchoring later edits). Reads exactly ONE file per call; to read several notes, issue several read_file calls in the same turn (they run in parallel). Use this to read a note before answering about it or editing it, instead of asking the user to paste its contents. By default returns up to the first 2000 lines; use offset/limit to page through longer notes. Lines longer than 2000 characters are truncated. Example: {"path": "Projects/Roadmap.md"}. Example paging: {"path": "Daily/2024-01-01.md", "offset": 400, "limit": 200}.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              "Path to the note/file to read, relative to the vault root (include the extension, e.g. 'Notes/Idea.md'). Must stay inside the vault; '..' escapes and absolute paths are rejected.",
          },
          offset: {
            type: 'integer',
            description: '1-based line number to start reading from (default: 1).',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of lines to return (default: 2000).',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description:
        'List the notes, files, and subfolders inside a vault folder. With recursive=false (default) it returns only the immediate entries of that folder; with recursive=true it walks the whole subtree (capped in size). Use this to discover where notes live before reading or editing them. Use the empty string or "." for the vault root. Do not use it merely to confirm a note you just wrote exists. Example: {"path": "."}. Example recursive: {"path": "Projects", "recursive": true}.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              "Folder to list, relative to the vault root. Use '.' or '' for the vault root. Must stay inside the vault.",
          },
          recursive: {
            type: 'boolean',
            description:
              'Set true to list the whole subtree, false (default) for the top level only.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description:
        'Search the vault for a regular-expression pattern and return matching lines with surrounding context (note path, line number, and a few lines around each hit). Use this to find which notes mention a topic, locate headings or tags, or track down where something was written, before reading the full notes. Craft the regex to be specific enough to keep results focused; the total output is capped, so narrow the search (use file_glob, a sub-folder, or a tighter pattern) if you get too many hits. Example: {"pattern": "#project/alpha", "path": ".", "file_glob": "*.md"}.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular-expression pattern to search for (JavaScript RegExp syntax).',
          },
          path: {
            type: 'string',
            description:
              "Folder to search recursively, relative to the vault root. Use '.' or '' for the whole vault. Must stay inside the vault.",
          },
          file_glob: {
            type: 'string',
            description:
              "Optional glob to restrict which files are searched, e.g. '*.md' or 'Projects/**/*.md'. Omit to search all text files.",
          },
        },
        required: ['pattern', 'path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a new note/file in the vault, or completely overwrite an existing one, with the full content provided. Parent folders are created automatically. MUTATES THE VAULT and requires explicit user approval before anything is written. Use this ONLY for a new note or an intentional full rewrite; to change part of an existing note use apply_diff instead (it is safer and does not require resending the whole note). ALWAYS provide the COMPLETE intended file content with no truncation, no line numbers, and no placeholders such as \'...rest of note unchanged...\' — partial content will produce a broken note. Example: {"path": "Notes/New Idea.md", "content": "# New Idea\\n\\nFirst draft.\\n"}.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Path of the note/file to write, relative to the vault root (include the extension). Must stay inside the vault.',
          },
          content: {
            type: 'string',
            description:
              'The COMPLETE content of the file. Include every line; never abbreviate or use placeholders. Do not include line numbers.',
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_diff',
      description:
        "Make surgical, targeted edits to an existing note using one or more search/replace blocks. This is the PREFERRED way to modify existing notes. MUTATES THE VAULT and requires explicit user approval before anything is written. The SEARCH text must match the current note content exactly, including whitespace and indentation; if you are not certain of the exact content, read_file first. The ':start_line:' line is REQUIRED and gives the 1-based line where the SEARCH block begins (this anchors the match and produces precise failure feedback). To make several edits in one note, concatenate multiple blocks in the 'diff' string. If a block fails to match, the tool returns the closest match it found with line numbers and a similarity score; re-read the note and retry with corrected SEARCH text. Each block has this exact format:\n<<<<<<< SEARCH\n:start_line:[line_number]\n-------\n[exact existing content to find]\n=======\n[new content to replace it with]\n>>>>>>> REPLACE",
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Path of the note/file to modify, relative to the vault root. Must stay inside the vault and the file must already exist.',
          },
          diff: {
            type: 'string',
            description:
              "One or more SEARCH/REPLACE blocks in the exact format described above. ':start_line:' is required on the SEARCH side; never put a start line on the REPLACE side.",
          },
        },
        required: ['path', 'diff'],
        additionalProperties: false,
      },
    },
  },
]
