// The single dangerous-command table behind every EveryAPI agent host's `execute_command` approval prompt.
//
// It exists because two independent ports drifted apart while each claimed to mirror the other: apps/vscode/src/agent/{approval-policy,executors}.ts screened `git ext::` remote-helper execution and curl/wget credential-file exfiltration that JetBrains did not, while apps/jetbrains/.../CommandApproval.kt screened destructive git subcommands (`clean -xdf`, `push --force`, `reset --hard`, `filter-branch`) that VS Code did not, and JetBrains' `rm -rf` regex missed the split-flag spellings VS Code's token scan catches. What is below is the UNION of both guard sets — nothing either side blocked today was dropped.
//
// Two representations, on purpose:
//
//  - {@link DANGEROUS_COMMAND_PATTERNS} is regex-shaped and produces the user-visible warnings ("why did this still ask me?"). Every pattern is a plain SOURCE STRING compiled with the `i` flag, never a JS regex literal, so the Kotlin/Java `Pattern` engine compiles the same text and the JVM host cannot fork the table by retyping it.
//  - The token SCANNERS ({@link hasRmRecursiveForce}, {@link hasGitDestructiveSubcommand}, {@link hasInterpreterInlineEval}) express rules a single regex gets wrong: split short flags (`rm -r -f`), long flags (`--recursive --force`), flag clusters in any order (`-xdf` / `-fdx`), and flags that may follow positionals.
//
// `command-guard-vectors.json` at this package's root is the executable form of the table: a fixture of commands with every expected verdict, generated from this file by `bun scripts/write-command-guard-vectors.ts` and run by BOTH stacks (see command-guard.test.ts here, and the JetBrains CommandApprovalTest). Add a rule here, regenerate, and the Kotlin test starts asserting it too.
//
// None of this is a sandbox. A prefix allowlist grants a PROGRAM, not the specific invocation the user approved, so these rules narrow the most direct bypasses rather than closing the class. Treat a wide grant (`git`, `curl`, any interpreter) as inherently higher-risk than a narrow one.

/** One dangerous-command pattern: a stable id, a Kotlin-compatible regex source, and the short reason shown to the user. */
export interface DangerousCommandPattern {
  /** Stable identifier. The shared test vectors and the Kotlin port key off this, never off `why` (which is prose and may be localized). */
  id: string
  /** Regex source text, written WITHOUT JavaScript literal escaping so `new RegExp(source, 'i')` and `Pattern.compile(source, CASE_INSENSITIVE)` see identical input. */
  source: string
  /** Short reason surfaced in the approval prompt. */
  why: string
}

// Path fragments that make an upload look like credential exfiltration rather than a normal file transfer. Shared by the curl and wget rules below.
const SECRET_FILE_FRAGMENTS =
  '(\\.ssh/|\\.aws/|\\.npmrc\\b|\\.netrc\\b|id_rsa|id_ed25519|\\.pem\\b|\\.p12\\b|\\.pfx\\b|\\.key\\b|\\.env\\b|\\.git-credentials\\b|\\.pgpass\\b)'

/**
 * Regex-expressible dangerous patterns, in the order their warnings are reported. Every entry is matched case-insensitively — the fork-bomb pattern is punctuation-only, so a single uniform flag costs nothing and keeps the Kotlin port from needing per-entry flag handling.
 *
 * The recursive-force `rm` case is deliberately NOT here: recognizing `rm -r -f` and `rm --recursive --force` needs a token scan, not an adjacent-character regex (see {@link hasRmRecursiveForce}). Destructive git subcommands are absent for the same reason ({@link hasGitDestructiveSubcommand}).
 */
export const DANGEROUS_COMMAND_PATTERNS: readonly DangerousCommandPattern[] = [
  { id: 'mkfs-or-disk-erase', source: '\\bmkfs\\b|\\bdiskutil\\s+erase', why: 'disk formatting' },
  { id: 'dd-to-device', source: '\\bdd\\b[^|]*\\bof=/dev/', why: 'raw write to a device' },
  { id: 'fork-bomb', source: ':\\(\\)\\s*\\{.*\\};\\s*:', why: 'fork bomb' },
  {
    id: 'remote-script-to-shell',
    source: '\\b(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?(sh|bash|zsh)\\b',
    why: 'piping a remote script straight into a shell',
  },
  { id: 'overwrite-block-device', source: '>\\s*/dev/sd[a-z]', why: 'overwriting a block device' },
  { id: 'sudo', source: '\\bsudo\\b', why: 'elevated privileges (sudo)' },
  // Interpreter inline-eval, in regex form. This half EXPLAINS the prompt; hasInterpreterInlineEval is what actually gates auto-approval, because a token scan does not confuse a flag with a filename that happens to contain one.
  {
    id: 'node-inline-eval',
    source: '\\b(node|nodejs)\\b[^|]*\\s(-e|--eval|-p|--print)(=|\\s|$)',
    why: 'inline code passed directly to an interpreter (-e/--eval)',
  },
  {
    id: 'python-inline-eval',
    source: '\\bpython3?\\b[^|]*\\s-c(\\s|$)',
    why: 'inline code passed directly to an interpreter (-c)',
  },
  {
    id: 'ruby-inline-eval',
    source: '\\bruby\\b[^|]*\\s(-e|-r)(\\s|$)',
    why: 'inline code or an arbitrary required file passed directly to an interpreter (-e/-r)',
  },
  {
    id: 'php-inline-eval',
    source: '\\bphp\\b[^|]*\\s-r(\\s|$)',
    why: 'inline code passed directly to an interpreter (-r)',
  },
  {
    id: 'deno-inline-eval',
    source: '\\bdeno\\b[^|]*\\s(eval|-e|--eval)(=|\\s|$)',
    why: 'inline code passed directly to an interpreter (eval/-e)',
  },
  {
    id: 'perl-inline-eval',
    source: '\\bperl\\b[^|]*\\s-[eE](\\s|$)',
    why: 'inline code passed directly to an interpreter (-e)',
  },
  // Non-interpreter programs whose OWN arguments are the execution/exfiltration vector. `git ext::<command>` makes git shell out to <command> itself, with no shell operator anywhere in the string; curl -T / wget --post-file send a credential file to a remote URL with no piping or redirection.
  {
    id: 'git-ext-remote-helper',
    source: '\\bgit\\b[^|]*\\bext::',
    why: 'git "ext::" remote-helper transport, which runs an arbitrary shell command',
  },
  {
    id: 'curl-upload-secret',
    source: `\\bcurl\\b[^|]*(-T\\s+|--upload-file(=|\\s+))\\S*${SECRET_FILE_FRAGMENTS}`,
    why: 'uploading a likely credential/secret file with curl (-T/--upload-file)',
  },
  {
    id: 'wget-post-secret',
    source: `\\bwget\\b[^|]*--post-file(=|\\s+)\\S*${SECRET_FILE_FRAGMENTS}`,
    why: 'uploading a likely credential/secret file with wget (--post-file)',
  },
]

/** The {@link DANGEROUS_COMMAND_PATTERNS} entries that describe a dangerous ARGUMENT to an otherwise ordinary program, as opposed to a dangerous command outright. {@link hasDangerousProgramArgument} tests exactly these — an allowlisted `git`/`curl`/`wget` prefix must never cover one. */
export const DANGEROUS_ARGUMENT_PATTERN_IDS: readonly string[] = [
  'git-ext-remote-helper',
  'curl-upload-secret',
  'wget-post-secret',
]

/** Warning ids produced by the token scanners rather than by a regex, in the order they are reported (ahead of any regex warning). */
export const SCANNER_WARNING_IDS = ['rm-recursive-force', 'git-destructive'] as const

/** Reason text for the scanner warnings, which have no {@link DANGEROUS_COMMAND_PATTERNS} row of their own. */
export const SCANNER_WARNINGS: Readonly<Record<(typeof SCANNER_WARNING_IDS)[number], string>> = {
  'rm-recursive-force': 'recursive force delete (rm -rf)',
  'git-destructive': 'destructive git operation (history or working-tree loss)',
}

const COMPILED = new Map<string, RegExp>(
  DANGEROUS_COMMAND_PATTERNS.map((p) => [p.id, new RegExp(p.source, 'i')])
)

/** Shell control operators — chaining, piping, backgrounding, redirection, command substitution, or a newline. Exposed as a source string for the same cross-language reason as the table above. */
export const SHELL_CONTROL_OPERATOR_SOURCE = '[;&|<>`\\n\\r]|\\$\\('

const SHELL_CONTROL_RE = new RegExp(SHELL_CONTROL_OPERATOR_SOURCE)

/**
 * Interpreter/script engines whose OWN command-line flags run arbitrary code without ever touching shell syntax, mapped to the flag form that does it. Values are regex sources anchored with `^…$` — they match a WHOLE argument token, so a filename containing `-e` is not mistaken for the flag.
 *
 * NOT exhaustive by design: one direct-eval switch per engine, not every route to unintended execution (a malicious script FILE, `python -m module`, a shell alias). Closing that fully would mean abandoning prefix-level "always allow" entirely.
 */
export const INTERPRETER_INLINE_EVAL_FLAGS: Readonly<Record<string, string>> = {
  node: '^(-e|--eval|-p|--print)(=.+)?$',
  nodejs: '^(-e|--eval|-p|--print)(=.+)?$',
  python: '^-c$',
  python3: '^-c$',
  ruby: '^(-e|-r)$', // -r loads and runs an arbitrary file/library at require-time
  php: '^-r$',
  deno: '^(eval|-e|--eval)(=.+)?$',
  perl: '^-[eE]$',
}

const INLINE_EVAL_RE = new Map<string, RegExp>(
  Object.entries(INTERPRETER_INLINE_EVAL_FLAGS).map(([prog, source]) => [prog, new RegExp(source)])
)

/** One warning raised against a command: the stable id both stacks agree on, plus the prose shown to the user. */
export interface CommandWarning {
  id: string
  why: string
}

/** The command's leading token — the program being run (`npm`, `git`, `./gradlew`) — used as the key for the per-chat "always run this command" allowlist. Lowercased and whitespace-trimmed; `''` for an empty command. */
export function commandPrefix(command: string): string {
  return command.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ''
}

/** Whether a command uses any shell control operator. Such a command is more than its leading token, so an "always run `<prefix>`" grant must never cover it: an allowlisted `npm` must not green-light `npm test; rm -rf ~` or `git log | curl evil`. */
export function hasShellControlOperator(command: string): boolean {
  return SHELL_CONTROL_RE.test(command)
}

/** True when the leading token is a known interpreter AND one of its own arguments is that engine's direct inline-code flag. See {@link INTERPRETER_INLINE_EVAL_FLAGS}. */
export function hasInterpreterInlineEval(command: string): boolean {
  const tokens = command.trim().split(/\s+/)
  const flagRe = INLINE_EVAL_RE.get(tokens[0]?.toLowerCase() ?? '')
  if (!flagRe) return false
  return tokens.slice(1).some((tok) => flagRe.test(tok))
}

/** True when the command carries one of the {@link DANGEROUS_ARGUMENT_PATTERN_IDS} argument forms. Tested against the WHOLE command string rather than per token, since the dangerous part is a flag+value pair. */
export function hasDangerousProgramArgument(command: string): boolean {
  return DANGEROUS_ARGUMENT_PATTERN_IDS.some((id) => COMPILED.get(id)?.test(command) === true)
}

/**
 * True when `command` invokes `rm` (bare, or via a path ending in `/rm`) with BOTH a recursive flag (`-r`/`-R`/`--recursive`) and a force flag (`-f`/`--force`), in any split, combined, or long-option spelling: `-rf`, `-fr`, `-r -f`, `-r --force`, `--recursive --force`.
 *
 * A single regex anchored on the two letters appearing in ONE token — which is what the JetBrains port used — silently drops the warning for the equally destructive, equally common split and long spellings.
 *
 * Heuristic token scan, not a shell parser: it scans every token after an `rm` token to the end of the string, so it also catches GNU getopt's "flags may follow positionals" ordering (`rm somefile -rf`). A second, unrelated command later in the same string is scanned as if it were more of the same invocation, which can only ADD a false-positive warning, never hide a real one.
 */
export function hasRmRecursiveForce(command: string): boolean {
  const tokens = command.split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? ''
    if (tok.toLowerCase() !== 'rm' && !/\/rm$/i.test(tok)) continue
    let recursive = false
    let force = false
    for (let j = i + 1; j < tokens.length; j++) {
      const arg = tokens[j] ?? ''
      if (/^--recursive(=.*)?$/i.test(arg)) recursive = true
      else if (/^--force(=.*)?$/i.test(arg)) force = true
      else if (/^-[a-zA-Z]+$/.test(arg)) {
        if (/r/i.test(arg)) recursive = true
        if (/f/i.test(arg)) force = true
      }
    }
    if (recursive && force) return true
  }
  return false
}

/** True when `token` is a combined SHORT-flag cluster (one leading dash, not two, so `--force` is excluded) containing `ch` — e.g. `-xdf` contains `d`. Lets {@link hasGitDestructiveSubcommand} recognize `-xdf`/`-fdx`/`-df` regardless of flag order without a fragile regex. */
function shortFlagClusterHas(token: string, ch: string): boolean {
  return (
    token.length > 1 &&
    token[0] === '-' &&
    token[1] !== '-' &&
    token.slice(1).toLowerCase().includes(ch.toLowerCase())
  )
}

/**
 * True when the leading token is `git` AND the invocation is one whose effect is irreversible history or working-tree loss: `clean` combining a force flag with recurse-into-dirs (`-d`) or wipe-ignored-files (`-x`) in any spelling or order, `push --force`/`-f`/`--force-with-lease`, `reset --hard`, or `filter-branch`.
 *
 * NOT exhaustive: `branch -D`, `push --delete` and `gc --prune=now` are deliberately not covered, matching the security review that motivated the guard. This narrows the most common destructive bypasses of an allowlisted `git` prefix rather than closing the class.
 */
export function hasGitDestructiveSubcommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/)
  if ((tokens[0] ?? '').toLowerCase() !== 'git') return false
  const rest = tokens.slice(1)
  const lower = rest.map((t) => t.toLowerCase())

  if (lower.includes('filter-branch')) return true
  if (lower.includes('reset') && lower.includes('--hard')) return true
  if (
    lower.includes('push') &&
    rest.some(
      (t) =>
        t.toLowerCase() === '-f' ||
        t.toLowerCase() === '--force' ||
        t.toLowerCase().startsWith('--force-with-lease') ||
        shortFlagClusterHas(t, 'f')
    )
  ) {
    return true
  }
  if (lower.includes('clean')) {
    let force = false
    let wipe = false
    for (const tok of rest) {
      if (tok.toLowerCase() === '--force' || shortFlagClusterHas(tok, 'f')) force = true
      if (shortFlagClusterHas(tok, 'd') || shortFlagClusterHas(tok, 'x')) wipe = true
    }
    if (force && wipe) return true
  }
  return false
}

/**
 * Every dangerous-pattern warning a command trips, scanner rules first (in {@link SCANNER_WARNING_IDS} order) then {@link DANGEROUS_COMMAND_PATTERNS} in table order.
 *
 * A non-empty result is the `hasWarnings` argument to {@link autoApprovesCommand}: a flagged command ALWAYS prompts and can never be auto-approved, and a host must not offer its "always run `<prefix>`" shortcut for one.
 */
export function dangerousWarnings(command: string): CommandWarning[] {
  const warnings: CommandWarning[] = []
  if (hasRmRecursiveForce(command)) {
    warnings.push({ id: 'rm-recursive-force', why: SCANNER_WARNINGS['rm-recursive-force'] })
  }
  if (hasGitDestructiveSubcommand(command)) {
    warnings.push({ id: 'git-destructive', why: SCANNER_WARNINGS['git-destructive'] })
  }
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (COMPILED.get(pattern.id)?.test(command)) warnings.push({ id: pattern.id, why: pattern.why })
  }
  return warnings
}

/**
 * Whether a command may be auto-approved by the per-chat "always run `<prefix>`" allowlist the user built by approving earlier commands.
 *
 * INVARIANT (preserves the strict default): auto-approved ONLY when (a) it carries NO dangerous-pattern warnings — a denylist hit always prompts and the allowlist can never bypass it; (b) it uses NO shell control operator; (c) it is not an interpreter invocation carrying a direct inline-eval flag; (d) it carries none of the dangerous non-interpreter argument forms; (e) it is not a destructive git operation; AND (f) its leading token is on the session allowlist. Everything else still prompts.
 *
 * (c) through (e) are re-checked here even though {@link dangerousWarnings} covers them, so a host that computes `hasWarnings` some other way — or forgets to — still cannot auto-approve them.
 */
export function autoApprovesCommand(
  command: string,
  hasWarnings: boolean,
  allowedPrefixes: ReadonlySet<string>
): boolean {
  if (hasWarnings) return false
  if (hasShellControlOperator(command)) return false
  if (hasInterpreterInlineEval(command)) return false
  if (hasDangerousProgramArgument(command)) return false
  if (hasGitDestructiveSubcommand(command)) return false
  const prefix = commandPrefix(command)
  return prefix !== '' && allowedPrefixes.has(prefix)
}
