/**
 * Minimal POSIX-shell splitter used to inspect model-written commands.
 *
 * It is deliberately approximate: it understands quoting, escapes, the
 * common control operators, redirections, heredocs, and `bash -c` nesting,
 * which is enough to recognise the program and arguments of each simple
 * command. It never executes or expands anything.
 */

/** One simple command inside a command line. */
export interface SimpleCommand {
  /** Words after quote removal, with leading `VAR=value` assignments dropped. */
  argv: string[]
  /** Leading `VAR=value` assignments of this simple command. */
  env: Record<string, string>
  /** Raw source text of this simple command. */
  text: string
  /** Standard input is supplied by a pipe, redirection, heredoc, or here-string. */
  stdinProvided: boolean
  /** Standard output is piped into another command. */
  stdoutPiped: boolean
  /** The command is sent to the background with a trailing `&`. */
  backgrounded: boolean
}

type Token =
  | { kind: 'word'; value: string; raw: string }
  | { kind: 'op'; value: string }

const OPERATORS = ['&&', '||', '|&', ';;', '<<<', '<<-', '<<', '>>', '&>', '>&', '<&', '|', ';', '&', '<', '>', '\n', '(', ')']

/**
 * Tokenize a command line into words and operators.
 * @param input - raw shell text.
 * @returns words (quotes removed) and control/redirection operators.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let word = ''
  let raw = ''
  let inWord = false
  const flush = (): void => {
    if (inWord) tokens.push({ kind: 'word', value: word, raw })
    word = ''
    raw = ''
    inWord = false
  }
  while (i < input.length) {
    const ch = input[i]!
    if (ch === '\\' && i + 1 < input.length) {
      if (input[i + 1] === '\n') { i += 2; continue }
      word += input[i + 1]
      raw += ch + input[i + 1]
      inWord = true
      i += 2
      continue
    }
    if (ch === "'") {
      const end = input.indexOf("'", i + 1)
      const stop = end === -1 ? input.length : end
      word += input.slice(i + 1, stop)
      raw += input.slice(i, stop + 1)
      inWord = true
      i = stop + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      let value = ''
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length && '"\\$`'.includes(input[j + 1]!)) {
          value += input[j + 1]
          j += 2
          continue
        }
        value += input[j]
        j += 1
      }
      word += value
      raw += input.slice(i, j + 1)
      inWord = true
      i = j + 1
      continue
    }
    if (ch === '#' && !inWord) {
      const end = input.indexOf('\n', i)
      i = end === -1 ? input.length : end
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush()
      i += 1
      continue
    }
    const op = OPERATORS.find(o => input.startsWith(o, i))
    if (op !== undefined) {
      // `2>&1`-style fd prefixes belong to the redirection, not the word.
      if (/^\d+$/.test(word) && inWord && (op.startsWith('>') || op.startsWith('<'))) {
        word = ''
        raw = ''
        inWord = false
      }
      flush()
      tokens.push({ kind: 'op', value: op })
      i += op.length
      if (op === '<<' || op === '<<-') i = skipHeredoc(input, i, tokens)
      continue
    }
    word += ch
    raw += ch
    inWord = true
    i += 1
  }
  flush()
  return tokens
}

/** Consume a heredoc delimiter and body; emits a placeholder word for the delimiter. */
function skipHeredoc(input: string, start: number, tokens: Token[]): number {
  let i = start
  while (input[i] === ' ' || input[i] === '\t') i += 1
  const match = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(input.slice(i))
  if (match === null) return i
  const delimiter = match[2]!
  tokens.push({ kind: 'word', value: delimiter, raw: match[0] })
  i += match[0].length
  const lineEnd = input.indexOf('\n', i)
  if (lineEnd === -1) return input.length
  // Keep the rest of the heredoc's first line (it may hold more of the command).
  const rest = input.slice(i, lineEnd)
  const bodyStart = lineEnd + 1
  const terminator = new RegExp(`^[\\t ]*${delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\t ]*$`, 'm')
  const body = input.slice(bodyStart)
  const end = terminator.exec(body)
  const after = end === null ? input.length : bodyStart + end.index + end[0].length
  tokens.push(...tokenize(rest))
  return after
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const REDIRECT_OPS = new Set(['<', '>', '>>', '&>', '>&', '<&', '<<<', '<<', '<<-'])
const INPUT_OPS = new Set(['<', '<<<', '<<', '<<-', '<&'])

/**
 * Split a command line into simple commands.
 * @param input - raw shell text.
 * @returns each simple command with its argv and stdin/background facts.
 */
export function splitCommands(input: string): SimpleCommand[] {
  const tokens = tokenize(input)
  const out: SimpleCommand[] = []
  let current: { words: Token[]; stdin: boolean; redirectNext: boolean } = { words: [], stdin: false, redirectNext: false }
  let pipedIn = false
  const finish = (separator: string | undefined): void => {
    const words = current.words.filter((t): t is Extract<Token, { kind: 'word' }> => t.kind === 'word')
    const argv = words.map(w => w.value)
    const env: Record<string, string> = {}
    while (argv.length > 0 && ASSIGNMENT.test(argv[0]!)) {
      const assignment = argv.shift()!
      const eq = assignment.indexOf('=')
      env[assignment.slice(0, eq)] = assignment.slice(eq + 1)
    }
    if (argv.length > 0) {
      out.push({
        argv,
        env,
        text: words.map(w => w.raw).join(' '),
        stdinProvided: current.stdin || pipedIn,
        stdoutPiped: separator === '|' || separator === '|&',
        backgrounded: separator === '&',
      })
    }
    pipedIn = separator === '|' || separator === '|&'
    current = { words: [], stdin: false, redirectNext: false }
  }
  for (const token of tokens) {
    if (token.kind === 'op') {
      if (REDIRECT_OPS.has(token.value)) {
        if (INPUT_OPS.has(token.value)) current.stdin = true
        current.redirectNext = true
        continue
      }
      if (token.value === '(' || token.value === ')') continue
      finish(token.value)
      continue
    }
    if (current.redirectNext) {
      current.redirectNext = false
      continue
    }
    current.words.push(token)
  }
  finish(undefined)
  return out
}
