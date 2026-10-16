/**
 * dsh-block-hanging-commands: stops foreground shell commands that would hang the turn.
 *
 * Listens on `tools/pre-execute` for the shell tools and denies (or asks
 * about) commands that wait for a human or never exit: editors, REPLs,
 * pagers, TUIs, `git commit` without `-m`, watch modes, dev servers,
 * `tail -f`, interactive logins. The denial tells the model the
 * non-interactive alternative, so it can retry in the same step.
 *
 * @module dsh-block-hanging-commands
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { analyzeCommand, RULE_IDS, type Finding, type RuleId } from './rules.ts'
import { resolveConfig } from './shared/live.ts'

export { analyzeCommand, RULE_IDS } from './rules.ts'
export type { Finding, RuleId, AnalyzeOptions } from './rules.ts'

export const name = 'block-hanging-commands'

/** Plugin configuration. */
export interface Config {
  /** `deny` returns the reason to the model; `ask` routes the call to the approval prompt. */
  mode: 'deny' | 'ask'
  /** Tool names whose `command` argument is inspected. */
  tools: string[]
  /** Set when the shell tool runs on a pseudo-terminal (e.g. dsh-tool-bash-persistent): enables pager and TTY-prompt rules. */
  pty: boolean
  /** Rule ids to turn off. */
  disabledRules: RuleId[]
  /** Regular expressions; a command matching any of them is never blocked. */
  allowPatterns: string[]
}

// Every field is `.volatile()` so the settings page on DSH's Plugins page can
// change it live; `apply` reads the current values on each call.
export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['deny', 'ask']).default('deny').description('deny: tell the model why and how to fix it. ask: show an approval prompt.').volatile(),
  tools: Schema.array(Schema.string()).default(['bash', 'pwsh']).description('Shell tool names to inspect.').volatile(),
  pty: Schema.boolean().default(false).description('Shell runs on a PTY (enables pager and sudo/apt prompt rules).').volatile(),
  disabledRules: Schema.array(Schema.union([...RULE_IDS])).default([]).description('Rules to disable.').volatile(),
  allowPatterns: Schema.array(Schema.string()).default([]).description('Regexes for commands that are always allowed.').volatile(),
}) as unknown as Schema<Config>

/**
 * Render the model-facing denial text.
 * @param finding - the detected hang.
 * @returns one paragraph naming the problem and the alternative.
 */
export function denialText(finding: Finding): string {
  const because = finding.reason.startsWith('`') ? finding.reason : `it ${finding.reason}`
  return `dsh-block-hanging-commands stopped \`${finding.command}\` before it ran, because ${because}, so the tool call would just sit there until it timed out. `
    + `Instead: ${finding.suggestion}. (rule: ${finding.rule})`
}

const BOUNDED_BY_TIMEOUT: ReadonlySet<RuleId> = new Set(['server', 'watch', 'follow'])

/**
 * Compile allow patterns. A pattern typed on the settings page that is not a
 * valid regex is skipped rather than taking the plugin down.
 * @param patterns - regex sources.
 * @returns the valid ones, compiled.
 */
export function compileAllowPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.flatMap((p) => {
    try {
      return [new RegExp(p)]
    } catch {
      return []
    }
  })
}

export function apply(ctx: Context, config: Config): void {
  let compiled: { source: readonly string[]; regexes: RegExp[] } | undefined
  const allowFor = (patterns: readonly string[]): RegExp[] => {
    if (compiled?.source !== patterns) compiled = { source: patterns, regexes: compileAllowPatterns(patterns) }
    return compiled.regexes
  }
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    const cfg = resolveConfig(config)
    if (!cfg.tools.includes(exec.name)) return next()
    const args = exec.arguments as { command?: unknown; run_in_background?: unknown; timeoutMs?: unknown } | null
    if (typeof args?.command !== 'string' || args.run_in_background === true) return next()
    const command = args.command
    if (allowFor(cfg.allowPatterns).some(re => re.test(command))) return next()
    const finding = analyzeCommand(command, { pty: cfg.pty, disabledRules: cfg.disabledRules, dialect: exec.name === 'pwsh' ? 'powershell' : 'posix' })
    if (finding === undefined) return next()
    // A timeout the model chose bounds a long-running command the same way `timeout N` does.
    // It doesn't help a command waiting for input: that only moves to the background, still stuck.
    if (typeof args.timeoutMs === 'number' && BOUNDED_BY_TIMEOUT.has(finding.rule)) return next()
    // Windows `timeout` only sleeps; it cannot bound another command.
    const text = exec.name === 'pwsh' ? denialText({ ...finding, suggestion: finding.suggestion.replace('bound it with `timeout <seconds>`', 'set a short `timeoutMs`') }) : denialText(finding)
    if (cfg.mode === 'ask') {
      return { kind: 'ask', reason: text, displayReason: { en: `This command may hang: ${finding.reason}.` } }
    }
    return { kind: 'deny', reason: text }
  })
}
