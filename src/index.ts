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

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['deny', 'ask']).default('deny').description('deny: tell the model why and how to fix it. ask: show an approval prompt.'),
  tools: Schema.array(Schema.string()).default(['bash']).description('Shell tool names to inspect.'),
  pty: Schema.boolean().default(false).description('Shell runs on a PTY (enables pager and sudo/apt prompt rules).'),
  disabledRules: Schema.array(Schema.union([...RULE_IDS])).default([]).description('Rules to disable.'),
  allowPatterns: Schema.array(Schema.string()).default([]).description('Regexes for commands that are always allowed.'),
}) as Schema<Config>

/**
 * Render the model-facing denial text.
 * @param finding - the detected hang.
 * @returns one paragraph naming the problem and the alternative.
 */
export function denialText(finding: Finding): string {
  return `dsh-block-hanging-commands blocked this command before it ran: \`${finding.command}\` ${finding.reason}, so the tool call would never return. `
    + `Instead: ${finding.suggestion}. (rule: ${finding.rule})`
}

export function apply(ctx: Context, config: Config): void {
  const tools = new Set(config.tools)
  const allow = config.allowPatterns.map((p) => {
    try {
      return new RegExp(p)
    } catch (error) {
      throw new Error(`block-hanging-commands: invalid allowPatterns entry ${JSON.stringify(p)}`, { cause: error })
    }
  })
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    if (!tools.has(exec.name)) return next()
    const args = exec.arguments as { command?: unknown; run_in_background?: unknown } | null
    if (typeof args?.command !== 'string' || args.run_in_background === true) return next()
    const command = args.command
    if (allow.some(re => re.test(command))) return next()
    const finding = analyzeCommand(command, { pty: config.pty, disabledRules: config.disabledRules })
    if (finding === undefined) return next()
    const text = denialText(finding)
    if (config.mode === 'ask') {
      return { kind: 'ask', reason: text, displayReason: { en: `This command may hang: ${finding.reason}.` } }
    }
    return { kind: 'deny', reason: text }
  })
}
