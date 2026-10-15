/**
 * Hang detection rules for model-written shell commands.
 *
 * Each rule inspects one simple command (after wrapper removal) and reports
 * why it would block a foreground tool call: it waits for a human (editor,
 * REPL, prompt, login), or it never exits on its own (server, watcher,
 * follower). A finding carries a concrete non-blocking alternative so the
 * model can retry immediately.
 */

import { splitCommands, type ShellDialect, type SimpleCommand } from './shell.ts'

/** Identifier of one rule; usable in `disabledRules`. */
export type RuleId =
  | 'editor'
  | 'pager'
  | 'tui'
  | 'repl'
  | 'remote-shell'
  | 'container-tty'
  | 'git-editor'
  | 'git-interactive'
  | 'watch'
  | 'server'
  | 'follow'
  | 'prompt'
  | 'login'
  | 'tty-prompt'

/** All rule ids, in evaluation order. */
export const RULE_IDS: readonly RuleId[] = [
  'editor', 'pager', 'tui', 'repl', 'remote-shell', 'container-tty', 'git-editor', 'git-interactive',
  'watch', 'server', 'follow', 'prompt', 'login', 'tty-prompt',
]

/** One detected hang. */
export interface Finding {
  rule: RuleId
  /** The simple command that triggered the rule. */
  command: string
  /** Why the command would block. */
  reason: string
  /** A non-blocking way to get the same result. */
  suggestion: string
}

/** Evaluation options. */
export interface AnalyzeOptions {
  /** The shell runs on a pseudo-terminal, so pagers and TTY prompts activate. */
  pty: boolean
  /** Rules to skip. */
  disabledRules?: readonly RuleId[]
  /** Quoting rules of the shell that runs the command. */
  dialect?: ShellDialect
}

interface Cmd {
  /** Basename of the program, lower-cased. */
  prog: string
  /** Arguments after the program. */
  args: string[]
  env: Record<string, string>
  stdin: boolean
  piped: boolean
  text: string
}

type Rule = (cmd: Cmd, opts: AnalyzeOptions) => Omit<Finding, 'rule' | 'command'> | undefined

const has = (args: readonly string[], ...flags: string[]): boolean =>
  args.some(a => flags.includes(a) || flags.some(f => f.startsWith('--') && a.startsWith(`${f}=`) && !/=(?:false|0|no)$/i.test(a)))

/** True when a short-flag cluster such as `-it` contains every given letter. */
const shortCluster = (args: readonly string[], letters: string): boolean => {
  const seen = new Set<string>()
  for (const a of args) {
    if (/^-[A-Za-z]+$/.test(a)) for (const ch of a.slice(1)) seen.add(ch)
  }
  return [...letters].every(ch => seen.has(ch))
}

const positionals = (args: readonly string[]): string[] => args.filter(a => !a.startsWith('-'))

/** Program name without its folder or Windows extension: `C:\\Tools\\npm.cmd` → `npm`. */
const basename = (path: string): string => {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return (slash === -1 ? path : path.slice(slash + 1)).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|com)$/, '')
}

const BG = 'run it with `run_in_background: true` (then read its output with the job tools), or bound it with `timeout <seconds>`'

const EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'pico', 'micro', 'joe', 'emacs', 'ed', 'ex', 'kak', 'hx', 'helix', 'mcedit', 'jed', 'ne'])
/** GUI editors that only block when told to wait for the window to close. */
const WAITING_EDITORS = new Set(['code', 'code-insiders', 'cursor', 'windsurf', 'subl', 'zed', 'mate', 'gedit', 'kate'])
const editor: Rule = (c) => {
  if (WAITING_EDITORS.has(c.prog) && (has(c.args, '--wait') || shortCluster(c.args, 'w'))) {
    return {
      reason: `opens \`${c.prog}\` and waits for its window to be closed`,
      suggestion: 'edit files with the write/edit tools instead',
    }
  }
  if (!EDITORS.has(c.prog)) return undefined
  if (c.prog === 'emacs' && has(c.args, '--batch', '-batch', '--script')) return undefined
  if ((c.prog === 'vim' || c.prog === 'nvim' || c.prog === 'ex' || c.prog === 'vi') && (has(c.args, '-es', '-Es', '--headless') || c.args.some(a => a.startsWith('+') && c.args.includes('+q')))) return undefined
  if (c.prog === 'ed' && c.stdin) return undefined
  return {
    reason: `opens the interactive editor \`${c.prog}\`, which waits for keystrokes that never arrive`,
    suggestion: 'edit files with the write/edit tools, or use a non-interactive tool such as `sed -i`',
  }
}

const PAGERS = new Set(['less', 'more', 'most', 'pg', 'man'])
const pager: Rule = (c, o) => {
  if (!o.pty || !PAGERS.has(c.prog)) return undefined
  return {
    reason: `\`${c.prog}\` is a pager and waits for keystrokes on a terminal`,
    suggestion: c.prog === 'man' ? 'use `man <page> | cat` or `<cmd> --help`' : 'use `cat`, `head`, or `sed -n "1,200p"`',
  }
}

const TUIS = new Map<string, string>([
  ['top', '`top -b -n 1` or `ps aux --sort=-%cpu | head`'],
  ['htop', '`ps aux --sort=-%cpu | head`'],
  ['btop', '`ps aux --sort=-%cpu | head`'],
  ['atop', '`ps aux --sort=-%cpu | head`'],
  ['glances', '`ps aux --sort=-%cpu | head`'],
  ['iotop', '`iotop -b -n 1`'],
  ['nmtui', '`nmcli`'],
  ['mc', '`ls`/`find`'],
  ['ranger', '`ls`/`find`'],
  ['nnn', '`ls`/`find`'],
  ['tig', '`git log --oneline -n 30`'],
  ['lazygit', 'plain `git` subcommands'],
  ['lazydocker', '`docker ps`'],
  ['k9s', '`kubectl get pods`'],
  ['ncdu', '`du -sh * | sort -h`'],
  ['nethogs', '`ss -tunap`'],
  ['iftop', '`ss -tunap`'],
  ['cmatrix', 'nothing; it never exits'],
  ['tmux', '`tmux new-session -d ...` / `tmux send-keys` / `tmux capture-pane -p`'],
  ['screen', '`screen -dmS <name> <cmd>`'],
])
const tui: Rule = (c) => {
  if (c.prog === 'watch') {
    return { reason: '`watch` re-runs its command forever and never exits', suggestion: `run the inner command once, or ${BG}` }
  }
  const alt = TUIS.get(c.prog)
  if (alt === undefined) return undefined
  if (c.prog === 'top' && c.args.some(a => /^-[A-Za-z]*b/.test(a))) return undefined
  if (c.prog === 'iotop' && has(c.args, '-b', '--batch')) return undefined
  if (c.prog === 'tmux') {
    const sub = positionals(c.args)[0]
    if (sub !== undefined && !['attach', 'attach-session', 'a', 'new', 'new-session'].includes(sub)) return undefined
    if ((sub === 'new' || sub === 'new-session') && has(c.args, '-d')) return undefined
  }
  if (c.prog === 'screen' && (shortCluster(c.args, 'd') || has(c.args, '-ls', '-list', '-X', '-Q'))) return undefined
  return { reason: `\`${c.prog}\` is a full-screen terminal UI and never exits on its own`, suggestion: `use ${alt}` }
}

const PYTHONS = /^(python(\d+(\.\d+)?)?|pypy3?|ipython3?|py|bpython|ptpython)$/
const replFinding = (name: string, how: string): Omit<Finding, 'rule' | 'command'> => ({
  reason: `starts an interactive \`${name}\` session that waits for input`,
  suggestion: how,
})
const repl: Rule = (c) => {
  if (c.stdin) return undefined
  const a = c.args
  const pos = positionals(a)
  if (PYTHONS.test(c.prog)) {
    if (c.prog.startsWith('ipython') || c.prog === 'bpython' || c.prog === 'ptpython') {
      return pos.length === 0 && !has(a, '-c') ? replFinding(c.prog, 'run a script file or `python -c "..."`') : undefined
    }
    if (has(a, '-i')) return replFinding(c.prog, 'drop `-i`; pass the code with `-c` or a script file')
    if (has(a, '-c', '-m') || pos.length > 0) return undefined
    return replFinding(c.prog, 'pass code with `python -c "..."`, a script file, or a heredoc on stdin')
  }
  if (c.prog === 'node' || c.prog === 'nodejs') {
    if (has(a, '-i', '--interactive')) return replFinding('node', 'drop `-i`; use `node -e "..."` or a script file')
    if (has(a, '-e', '--eval', '-p', '--print', '--test', '--run') || pos.length > 0) return undefined
    return replFinding('node', 'use `node -e "..."`, `node -p "..."`, or a script file')
  }
  if (c.prog === 'deno' || c.prog === 'bun') {
    if (pos[0] === 'repl' || a.length === 0) return replFinding(c.prog, `use \`${c.prog} eval "..."\` or \`${c.prog} run <file>\``)
    return undefined
  }
  const bareRepls: Record<string, string> = {
    irb: '`ruby -e "..."`', pry: '`ruby -e "..."`', ghci: '`runghc <file>` or `ghc -e "..."`',
    erl: '`erl -noshell -eval "...,halt()."`', lua: '`lua -e "..."`', luajit: '`luajit -e "..."`',
    julia: '`julia -e "..."`', scala: '`scala <file>`', clj: '`clj -M -e "..."`', clojure: '`clojure -M -e "..."`',
    racket: '`racket -e "..."`', guile: '`guile -c "..."`', ocaml: '`ocaml <file>`', swipl: '`swipl -g goal -t halt`',
    sbcl: '`sbcl --script <file>`', R: '`Rscript -e "..."`', r: '`Rscript -e "..."`', jshell: '`java <File>.java`',
    kotlinc: '`kotlinc -script <file>.kts`', gdb: '`gdb -batch -ex ...`', lldb: '`lldb --batch -o ...`',
    ftp: 'a scripted client such as `curl`', sftp: '`sftp -b <batchfile>` or `scp`', telnet: '`nc -w 5 host port`',
    bc: '`echo "..." | bc`', dc: '`echo "..." | dc`',
  }
  const bare = bareRepls[c.prog]
  if (bare !== undefined) {
    if (c.prog === 'gdb' && has(a, '-batch', '--batch')) return undefined
    if (c.prog === 'lldb' && has(a, '--batch', '-b')) return undefined
    if (c.prog === 'sftp' && has(a, '-b')) return undefined
    if (c.prog === 'erl' && has(a, '-noshell')) return undefined
    if (['gdb', 'lldb', 'ftp', 'sftp', 'telnet'].includes(c.prog)) return replFinding(c.prog, `use ${bare}`)
    if (pos.length > 0 || a.some(x => ['-e', '-c', '-g', '--script', '--eval', '-M', '-script'].includes(x))) return undefined
    return replFinding(c.prog, `use ${bare}`)
  }
  if (c.prog === 'php') {
    return has(a, '-a') ? replFinding('php', 'use `php -r "..."` or a script file') : undefined
  }
  if (c.prog === 'iex') {
    return replFinding('iex', 'use `elixir -e "..."` or `mix run -e "..."`')
  }
  if (c.prog === 'psql') {
    if (has(a, '-c', '--command', '-f', '--file', '-l', '--list')) return undefined
    return replFinding('psql', 'pass the SQL with `psql -c "..."` or `-f file.sql`')
  }
  if (c.prog === 'mysql' || c.prog === 'mariadb') {
    if (has(a, '-e', '--execute') || a.some(x => /^-e./.test(x))) return undefined
    return replFinding(c.prog, `pass the SQL with \`${c.prog} -e "..."\` or \`< file.sql\``)
  }
  if (c.prog === 'sqlite3' || c.prog === 'sqlite') {
    if (pos.length >= 2 || has(a, '-cmd', '--version', '-version')) return undefined
    return replFinding(c.prog, 'pass the SQL as an argument: `sqlite3 db.sqlite "select ..."`')
  }
  if (c.prog === 'redis-cli' || c.prog === 'valkey-cli') {
    const valueFlags = new Set(['-h', '-p', '-a', '-n', '-u', '-s', '--user', '--pass'])
    const cmdWords = a.filter((x, i) => !x.startsWith('-') && !valueFlags.has(a[i - 1] ?? ''))
    if (cmdWords.length > 0 || has(a, '--scan', '--bigkeys', '--stat', '--eval')) return undefined
    return replFinding(c.prog, `pass the command: \`${c.prog} PING\``)
  }
  if (c.prog === 'mongosh' || c.prog === 'mongo') {
    if (has(a, '--eval', '-f', '--file') || a.some(x => x.endsWith('.js'))) return undefined
    return replFinding(c.prog, `use \`${c.prog} --eval "..."\``)
  }
  if (['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh'].includes(c.prog)) {
    if (has(a, '-c', '-s') || pos.length > 0 || has(a, '--version', '--help')) return undefined
    return replFinding(c.prog, 'run the commands directly, or pass them with `-c`')
  }
  if (c.prog === 'pwsh' || c.prog === 'powershell') {
    if (pos.length > 0 || a.some(x => /^-(?:c|command|f|file|encodedcommand|version|help|\?)$/i.test(x))) return undefined
    return replFinding(c.prog, 'run the commands directly, or pass them with `-Command "..."`')
  }
  return undefined
}

const SSH_VALUE_FLAGS = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B'])
const remoteShell: Rule = (c) => {
  if (c.prog === 'mosh') return { reason: '`mosh` opens an interactive remote shell', suggestion: 'use `ssh host "<command>"`' }
  if (c.prog !== 'ssh') return undefined
  if (has(c.args, '-V', '-G', '-O')) return undefined
  if (c.args.some(a => /^-[A-Za-z]*N[A-Za-z]*$/.test(a))) {
    return { reason: '`ssh -N` holds a tunnel open and never exits', suggestion: BG }
  }
  const words: string[] = []
  for (let i = 0; i < c.args.length; i += 1) {
    const a = c.args[i]!
    if (SSH_VALUE_FLAGS.has(a)) { i += 1; continue }
    if (a.startsWith('-')) continue
    words.push(a)
  }
  if (words.length >= 2 || c.stdin) return undefined
  return {
    reason: '`ssh` without a remote command opens an interactive login shell',
    suggestion: 'pass the command to run: `ssh host "<command>"` (add `-o BatchMode=yes` so it fails instead of prompting for a password)',
  }
}

const CONTAINER_CLIS = new Set(['docker', 'podman', 'nerdctl'])
const containerTty: Rule = (c) => {
  const sub = c.args[0]
  if (CONTAINER_CLIS.has(c.prog)) {
    if (sub === 'attach') return { reason: `\`${c.prog} attach\` streams a container's console until it exits`, suggestion: `use \`${c.prog} logs --tail 200 <container>\`` }
    if ((sub === 'run' || sub === 'exec' || sub === 'start') && (shortCluster(c.args, 'it') || (has(c.args, '--interactive') && has(c.args, '--tty')) || (sub === 'start' && has(c.args, '-a', '-i', '--attach', '--interactive')))) {
      return { reason: `\`${c.prog} ${sub} -it\` needs an interactive terminal`, suggestion: `drop \`-it\` and pass the command to run, e.g. \`${c.prog} ${sub === 'start' ? 'exec' : sub} <container> <command>\`` }
    }
    return undefined
  }
  if (c.prog === 'kubectl' || c.prog === 'oc') {
    if (sub === 'attach') return { reason: `\`${c.prog} attach\` streams a pod's console`, suggestion: `use \`${c.prog} logs --tail 200 <pod>\`` }
    if ((sub === 'exec' || sub === 'run' || sub === 'debug') && (shortCluster(c.args, 'it') || (has(c.args, '--stdin') && has(c.args, '--tty')))) {
      return { reason: `\`${c.prog} ${sub} -it\` needs an interactive terminal`, suggestion: `drop \`-it\`: \`${c.prog} exec <pod> -- <command>\`` }
    }
  }
  return undefined
}

const gitSub = (c: Cmd): { sub: string | undefined; rest: string[]; editorSet: boolean } => {
  let i = 0
  let editorSet = c.env.GIT_EDITOR !== undefined || c.env.EDITOR !== undefined || c.env.GIT_SEQUENCE_EDITOR !== undefined
  while (i < c.args.length && c.args[i]!.startsWith('-')) {
    const a = c.args[i]!
    if (a === '-c' || a === '-C' || a === '--git-dir' || a === '--work-tree') {
      if (a === '-c' && /^core\.editor=|^sequence\.editor=/.test(c.args[i + 1] ?? '')) editorSet = true
      i += 2
      continue
    }
    i += 1
  }
  return { sub: c.args[i], rest: c.args.slice(i + 1), editorSet }
}

const gitEditor: Rule = (c) => {
  if (c.prog !== 'git') return undefined
  const { sub, rest, editorSet } = gitSub(c)
  if (editorSet || sub === undefined) return undefined
  const noEdit = has(rest, '--no-edit')
  if (sub === 'commit') {
    if (has(rest, '-m', '--message', '-F', '--file', '-C', '--reuse-message', '--no-edit', '--fixup', '--squash', '--allow-empty-message', '--dry-run') || rest.some(a => /^-[a-zA-Z]*m./.test(a) || /^-[a-zA-Z]*m$/.test(a) || /^-[a-zA-Z]*F/.test(a))) return undefined
    return { reason: '`git commit` without a message opens an editor', suggestion: 'pass the message: `git commit -m "<message>"` (or `--no-edit` when amending)' }
  }
  if (sub === 'tag' && has(rest, '-a', '--annotate', '-s', '--sign') && !has(rest, '-m', '--message', '-F', '--file')) {
    return { reason: '`git tag -a` without `-m` opens an editor', suggestion: 'add `-m "<message>"`' }
  }
  if (sub === 'revert' && !noEdit && !has(rest, '-n', '--no-commit', '--abort', '--quit', '--skip', '--continue')) {
    return { reason: '`git revert` opens an editor for the commit message', suggestion: 'add `--no-edit`' }
  }
  if ((sub === 'rebase' || sub === 'merge' || sub === 'cherry-pick' || sub === 'revert' || sub === 'am') && has(rest, '--continue') && !noEdit) {
    return { reason: `\`git ${sub} --continue\` opens an editor for the commit message`, suggestion: `run \`GIT_EDITOR=true git ${sub} --continue\`` }
  }
  if (sub === 'merge' && has(rest, '-e', '--edit')) {
    return { reason: '`git merge --edit` opens an editor', suggestion: 'drop `--edit` or use `--no-edit`' }
  }
  return undefined
}

const gitInteractive: Rule = (c) => {
  if (c.prog !== 'git') return undefined
  const { sub, rest, editorSet } = gitSub(c)
  if (sub === 'rebase' && has(rest, '-i', '--interactive') && !editorSet) {
    return { reason: '`git rebase -i` opens an interactive todo editor', suggestion: 'use a non-interactive rebase (`git rebase <base>`), `git commit --fixup` + `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <base>`, or `git reset --soft`' }
  }
  if ((sub === 'add' || sub === 'checkout' || sub === 'reset' || sub === 'stash' || sub === 'restore' || sub === 'commit') && (has(rest, '-p', '--patch') || (sub === 'add' && has(rest, '-i', '--interactive')))) {
    return { reason: `\`git ${sub} --patch\` asks about every hunk interactively`, suggestion: `stage whole paths (\`git ${sub} <path>\`), or write a patch file and \`git apply --cached\`` }
  }
  if (sub === 'mergetool' || sub === 'difftool') {
    return { reason: `\`git ${sub}\` launches an interactive merge/diff tool`, suggestion: sub === 'difftool' ? 'use `git diff`' : 'resolve conflicts by editing the files, then `git add`' }
  }
  if (sub === 'clean' && has(rest, '-i', '--interactive')) {
    return { reason: '`git clean -i` is interactive', suggestion: 'review with `git clean -n`, then `git clean -f`' }
  }
  return undefined
}

const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
/** The script a package-manager invocation runs, if any. */
const scriptName = (c: Cmd): string | undefined => {
  if (!PACKAGE_RUNNERS.has(c.prog)) return undefined
  const pos = positionals(c.args)
  const first = pos[0]
  if (first === undefined) return undefined
  if (first === 'run' || first === 'run-script') return pos[1]
  if (first === 'start' || first === 'test' || first === 't') return first === 't' ? 'test' : first
  if (c.prog === 'npm') return undefined
  const builtins = new Set(['add', 'install', 'i', 'remove', 'rm', 'update', 'up', 'exec', 'dlx', 'x', 'create', 'init', 'link', 'unlink', 'publish', 'pack', 'info', 'view', 'why', 'list', 'ls', 'outdated', 'audit', 'config', 'set', 'get', 'cache', 'store', 'build', 'rebuild', 'prune', 'import', 'patch', 'version', 'help', 'login', 'logout', 'whoami', 'workspace', 'workspaces', 'upgrade', 'global', 'licenses', 'pm', 'setup', 'env', 'bin', 'root', 'fetch', 'deploy', 'node', 'ci'])
  return builtins.has(first) ? undefined : first
}

const afterDoubleDash = (args: readonly string[]): string[] => {
  const i = args.indexOf('--')
  return i === -1 ? [] : args.slice(i + 1)
}

const WATCH_PROGS: Record<string, (args: string[]) => boolean> = {
  nodemon: () => true,
  'ts-node-dev': () => true,
  'tsx': (a) => a[0] === 'watch' || has(a, '--watch'),
  'cargo-watch': () => true,
  ptw: () => true,
  'pytest-watch': () => true,
  watchexec: () => true,
  entr: () => true,
  air: () => true,
  reflex: () => true,
  chokidar: () => true,
  onchange: () => true,
  'browser-sync': () => true,
  tsc: (a) => has(a, '-w', '--watch'),
  jest: (a) => has(a, '--watch', '--watchAll'),
  vitest: (a) => a[0] === 'watch' || a[0] === 'dev' || has(a, '--watch', '-w'),
  mocha: (a) => has(a, '-w', '--watch'),
  ava: (a) => has(a, '-w', '--watch'),
  webpack: (a) => has(a, '-w', '--watch'),
  rollup: (a) => has(a, '-w', '--watch'),
  esbuild: (a) => has(a, '--watch'),
  vite: (a) => a[0] === 'build' && has(a, '-w', '--watch'),
  tailwindcss: (a) => has(a, '-w', '--watch'),
  sass: (a) => has(a, '--watch', '-w'),
  less: () => false,
  parcel: (a) => a[0] === 'watch',
  cargo: (a) => a[0] === 'watch',
  node: (a) => has(a, '--watch', '--watch-path'),
  deno: (a) => has(a, '--watch'),
  bun: (a) => has(a, '--watch', '--hot'),
  gulp: (a) => positionals(a).some(p => /watch/.test(p)),
  grunt: (a) => positionals(a).some(p => /watch/.test(p)),
  ng: (a) => a[0] === 'test' && !has(a, '--watch=false', '--no-watch', '--single-run'),
  karma: (a) => a[0] === 'start' && !has(a, '--single-run', '--single-run=true'),
  skaffold: (a) => a[0] === 'dev',
  tilt: (a) => a[0] === 'up',
  dotnet: (a) => a[0] === 'watch',
  gradle: (a) => has(a, '--continuous', '-t'),
  './gradlew': (a) => has(a, '--continuous', '-t'),
  gradlew: (a) => has(a, '--continuous', '-t'),
}
const watch: Rule = (c, o) => {
  const script = scriptName(c)
  if (script !== undefined) {
    const extra = afterDoubleDash(c.args)
    if (/(^|[:_-])watch($|[:_-])/.test(script) || has(extra, '--watch', '--watchAll', '-w')) {
      return { reason: `\`${c.prog} ${script}\` runs in watch mode and never exits`, suggestion: `run the one-shot variant (e.g. \`${c.prog} test -- --watch=false\` / \`vitest run\` / \`jest --ci\`), or ${BG}` }
    }
    return undefined
  }
  if (c.prog === 'vitest' && o.pty && positionals(c.args)[0] === undefined) {
    return { reason: '`vitest` without `run` starts watch mode on a terminal', suggestion: 'use `vitest run`' }
  }
  const check = WATCH_PROGS[c.prog]
  if (check !== undefined && check(c.args)) {
    return { reason: `\`${c.prog}\` is running in watch mode and never exits`, suggestion: `run it once without the watch flag, or ${BG}` }
  }
  return undefined
}

const SERVER_SCRIPTS = /^(dev|develop|start|serve|server|preview|watch|storybook|start:dev|dev:.*|serve:.*|start:.*)$/
/** `dev:build`, `start:migrate` and friends are one-shot tasks despite the prefix. */
const ONE_SHOT_SCRIPT = /[:_-](?:build|lint|test|check|types?|typecheck|clean|gen|generate|codegen|format|fmt|setup|db|migrate|seed|install|prepare|deps|docs?|once|ci)(?:$|[:_-])/
const SERVER_PROGS: Record<string, (args: string[]) => boolean> = {
  next: (a) => a[0] === 'dev' || a[0] === 'start',
  vite: (a) => a[0] === undefined || a[0].startsWith('-') || ['dev', 'serve', 'preview'].includes(a[0]),
  nuxt: (a) => ['dev', 'preview', 'start'].includes(a[0] ?? ''),
  nuxi: (a) => ['dev', 'preview'].includes(a[0] ?? ''),
  astro: (a) => ['dev', 'preview', 'start'].includes(a[0] ?? ''),
  remix: (a) => a[0] === 'dev',
  'svelte-kit': (a) => a[0] === 'dev',
  ng: (a) => a[0] === 'serve' || a[0] === 's',
  'react-scripts': (a) => a[0] === 'start',
  webpack: (a) => a[0] === 'serve',
  'webpack-dev-server': () => true,
  'vue-cli-service': (a) => a[0] === 'serve',
  gatsby: (a) => a[0] === 'develop' || a[0] === 'serve',
  expo: (a) => a[0] === 'start',
  'react-native': (a) => a[0] === 'start',
  docusaurus: (a) => a[0] === 'start' || a[0] === 'serve',
  storybook: (a) => a[0] === 'dev',
  'start-storybook': () => true,
  wrangler: (a) => a[0] === 'dev',
  netlify: (a) => a[0] === 'dev',
  vercel: (a) => a[0] === 'dev',
  firebase: (a) => a[0] === 'serve' || a[0] === 'emulators:start',
  eleventy: (a) => has(a, '--serve', '--watch'),
  'http-server': () => true,
  'live-server': () => true,
  'json-server': () => true,
  serve: (a) => !has(a, '--help', '-h'),
  flask: (a) => a[0] === 'run',
  uvicorn: () => true,
  gunicorn: () => true,
  hypercorn: () => true,
  daphne: () => true,
  waitress: () => true,
  'waitress-serve': () => true,
  fastapi: (a) => a[0] === 'dev' || a[0] === 'run',
  streamlit: (a) => a[0] === 'run',
  jupyter: (a) => ['notebook', 'lab', 'server'].includes(a[0] ?? ''),
  'jupyter-lab': () => true,
  'jupyter-notebook': () => true,
  mkdocs: (a) => a[0] === 'serve',
  celery: (a) => a.includes('worker') || a.includes('beat'),
  rails: (a) => a[0] === 's' || a[0] === 'server',
  rackup: () => true,
  puma: () => true,
  unicorn: () => true,
  jekyll: (a) => a[0] === 'serve' || a[0] === 's',
  hugo: (a) => a[0] === 'server' || a[0] === 'serve',
  zola: (a) => a[0] === 'serve',
  symfony: (a) => a[0] === 'serve' || a[0] === 'server:start',
  caddy: (a) => a[0] === 'run' || a[0] === 'file-server' || a[0] === 'reverse-proxy',
  'redis-server': () => true,
  mongod: () => true,
  ngrok: () => true,
  cloudflared: (a) => a[0] === 'tunnel',
  minikube: (a) => a[0] === 'tunnel' || a[0] === 'dashboard',
  stripe: (a) => a[0] === 'listen',
  mitmproxy: () => true,
  mitmweb: () => true,
  'php-fpm': (a) => has(a, '-F', '--nodaemonize'),
  yes: () => false,
}
const server: Rule = (c) => {
  const script = scriptName(c)
  if (script !== undefined) {
    if (SERVER_SCRIPTS.test(script) && !ONE_SHOT_SCRIPT.test(script)) {
      return { reason: `\`${c.prog} run ${script}\` usually starts a long-running server or watcher that never exits`, suggestion: `${BG}; then probe it with \`curl\`` }
    }
    return undefined
  }
  const pos = positionals(c.args)
  if (PYTHONS.test(c.prog) && c.args[0] === '-m' && ['http.server', 'SimpleHTTPServer', 'uvicorn', 'flask', 'gunicorn', 'streamlit', 'jupyter', 'mkdocs', 'pydoc'].includes(c.args[1] ?? '')) {
    const mod = c.args[1]!
    if (mod === 'flask' && c.args[2] !== 'run') return undefined
    if ((mod === 'streamlit' || mod === 'mkdocs') && !['run', 'serve'].includes(c.args[2] ?? '')) return undefined
    if (mod === 'jupyter' && !['notebook', 'lab'].includes(c.args[2] ?? '')) return undefined
    if (mod === 'pydoc' && !has(c.args, '-p', '-b')) return undefined
    return { reason: `\`python -m ${mod}\` starts a server that never exits`, suggestion: `${BG}; then probe it with \`curl\`` }
  }
  if (PYTHONS.test(c.prog) && pos.some(p => /(^|\/)manage\.py$/.test(p)) && pos.includes('runserver')) {
    return { reason: '`manage.py runserver` starts a server that never exits', suggestion: `${BG}; then probe it with \`curl\`` }
  }
  if (c.prog === 'php' && (has(c.args, '-S') || (pos[0] === 'artisan' && (pos[1] === 'serve' || pos[1] === 'queue:work' || pos[1] === 'horizon')))) {
    return { reason: '`php` is starting a server or worker that never exits', suggestion: `${BG}; then probe it with \`curl\`` }
  }
  if ((CONTAINER_CLIS.has(c.prog) && c.args[0] === 'compose' && c.args.includes('up')) || (c.prog === 'docker-compose' && c.args.includes('up'))) {
    if (has(c.args, '-d', '--detach', '--wait', '--abort-on-container-exit', '--exit-code-from')) return undefined
    return { reason: '`compose up` without `-d` attaches to container logs and never exits', suggestion: 'add `-d` (or `--wait`), then check `docker compose ps` / `docker compose logs --tail 100`' }
  }
  // `yes` on its own floods the output forever; `yes | cmd` is the usual way to answer prompts.
  if (c.prog === 'yes' && !c.piped) return { reason: '`yes` prints forever and never exits', suggestion: 'pipe it into the command that needs answers (`yes | <command>`), or drop it' }
  const check = SERVER_PROGS[c.prog]
  if (check !== undefined && check(c.args) && !has(c.args, '--help', '-h', '--version')) {
    return { reason: `\`${c.prog}\` starts a long-running process that never exits`, suggestion: `${BG}; then probe it with \`curl\`` }
  }
  return undefined
}

const follow: Rule = (c) => {
  const a = c.args
  if (['get-content', 'gc', 'cat', 'type'].includes(c.prog) && a.some(x => /^-wait$/i.test(x))) {
    return { reason: '`Get-Content -Wait` follows the file forever', suggestion: 'use `Get-Content <file> -Tail 200` (without `-Wait`)' }
  }
  if (c.prog === 'tail' && (has(a, '-f', '-F', '--follow') || a.some(x => /^--follow=/.test(x) || /^-[0-9]*[fF]$/.test(x)))) {
    return { reason: '`tail -f` follows the file forever', suggestion: 'use `tail -n 200 <file>` (without `-f`)' }
  }
  if (c.prog === 'journalctl' && has(a, '-f', '--follow')) {
    return { reason: '`journalctl -f` follows the journal forever', suggestion: 'use `journalctl -n 200 --no-pager`' }
  }
  if ((CONTAINER_CLIS.has(c.prog) || c.prog === 'kubectl' || c.prog === 'oc' || c.prog === 'docker-compose') && (a.includes('logs') || a[0] === 'events') && (has(a, '-f', '--follow') || a[0] === 'events')) {
    if (a[0] === 'events' && has(a, '--since') && has(a, '--until')) return undefined
    return { reason: `\`${c.prog} ${a[0]}${a[0] === 'events' ? '' : ' -f'}\` streams forever`, suggestion: `use \`${c.prog} logs --tail 200 <name>\` (without \`-f\`)` }
  }
  if ((c.prog === 'kubectl' || c.prog === 'oc') && (a[0] === 'port-forward' || a[0] === 'proxy' || has(a, '-w', '--watch', '--watch-only'))) {
    return { reason: `\`${c.prog} ${a[0]}\` keeps running until interrupted`, suggestion: a[0] === 'port-forward' || a[0] === 'proxy' ? BG : 'drop `--watch` and poll with a plain `get`' }
  }
  if (c.prog === 'ping' && !has(a, '-c', '-n', '-w', '-W') && !a.some(x => /^-c\d+$/.test(x))) {
    return { reason: '`ping` without a count runs forever', suggestion: 'add a count: `ping -c 4 <host>`' }
  }
  if ((c.prog === 'nc' || c.prog === 'ncat' || c.prog === 'netcat') && (has(a, '-l', '--listen') || a.some(x => /^-[a-zA-Z]*l[a-zA-Z]*$/.test(x)))) {
    return { reason: '`nc -l` listens until a peer connects and disconnects', suggestion: BG }
  }
  if (c.prog === 'tcpdump' && !has(a, '-c') && !has(a, '-r')) {
    return { reason: '`tcpdump` without `-c` captures forever', suggestion: 'add a packet count: `tcpdump -c 50 ...`' }
  }
  if (c.prog === 'adb' && a[0] === 'logcat' && !has(a, '-d')) {
    return { reason: '`adb logcat` streams forever', suggestion: 'use `adb logcat -d` to dump and exit' }
  }
  if (c.prog === 'sleep' && (a[0] === 'infinity' || a[0] === 'inf')) {
    return { reason: '`sleep infinity` never exits', suggestion: 'use a finite duration' }
  }
  if (c.prog === 'cat' && a.length === 0 && !c.stdin) {
    return undefined
  }
  return undefined
}

const prompt: Rule = (c) => {
  const a = c.args
  if (c.prog === 'read-host' || c.prog === 'pause' || (c.prog === 'cmd' && a.length === 0)) {
    return { reason: `\`${c.prog}\` waits for someone to type at the console`, suggestion: 'pass the value directly, or ask the user in chat' }
  }
  if ((c.prog === 'npm' || c.prog === 'yarn') && (a[0] === 'init' && positionals(a).length === 1) && !has(a, '-y', '--yes')) {
    return { reason: `\`${c.prog} init\` asks a series of questions`, suggestion: `use \`${c.prog} init -y\`` }
  }
  if (c.prog === 'ssh-keygen' && !has(a, '-N') && !has(a, '-l', '-F', '-R', '-y', '-Y', '-H', '-r', '-k', '-Q', '-e', '-i', '-D') ) {
    return { reason: '`ssh-keygen` prompts for a file name and passphrase', suggestion: 'pass them: `ssh-keygen -t ed25519 -f <path> -N ""`' }
  }
  if (['passwd', 'adduser', 'visudo', 'vipw', 'crontab'].includes(c.prog) && !(c.prog === 'crontab' && !has(a, '-e')) && !(c.prog === 'adduser' && has(a, '--disabled-password', '--gecos'))) {
    return { reason: `\`${c.prog}${c.prog === 'crontab' ? ' -e' : ''}\` is interactive`, suggestion: c.prog === 'crontab' ? 'write the table to a file and run `crontab <file>`' : 'use a non-interactive equivalent (`chpasswd`, `useradd`, a drop-in file)' }
  }
  if (c.prog === 'read' && !c.stdin) {
    return { reason: '`read` waits for a line on standard input', suggestion: 'provide the value directly instead of reading it' }
  }
  return undefined
}

const login: Rule = (c) => {
  const a = c.args
  const pos = positionals(a)
  const say = (what: string, how: string): Omit<Finding, 'rule' | 'command'> => ({
    reason: `\`${what}\` starts an interactive or browser login that waits for a human`,
    suggestion: `${how}; or ask the user to log in themselves`,
  })
  if (c.prog === 'gh' && pos[0] === 'auth' && pos[1] === 'login' && !has(a, '--with-token')) return say('gh auth login', 'use `echo "$TOKEN" | gh auth login --with-token` or set `GH_TOKEN`')
  if ((c.prog === 'npm' || c.prog === 'pnpm' || c.prog === 'yarn') && (pos[0] === 'login' || pos[0] === 'adduser')) return say(`${c.prog} login`, 'write an auth token to `.npmrc` or set `NPM_TOKEN`')
  if (CONTAINER_CLIS.has(c.prog) && pos[0] === 'login' && !has(a, '--password-stdin', '-p', '--password')) return say(`${c.prog} login`, `use \`echo "$TOKEN" | ${c.prog} login -u <user> --password-stdin <registry>\``)
  if (c.prog === 'az' && pos[0] === 'login' && !has(a, '--service-principal', '--identity', '--use-device-code')) return say('az login', 'use `az login --service-principal ...` or `--identity`')
  if (c.prog === 'gcloud' && pos[0] === 'auth' && (pos[1] === 'login' || pos[1] === 'application-default') && !has(a, '--cred-file', '--no-browser')) return say(`gcloud auth ${pos[1]}`, 'use `gcloud auth activate-service-account --key-file ...`')
  if (['firebase', 'vercel', 'netlify', 'heroku', 'wrangler', 'fly', 'flyctl', 'railway', 'supabase', 'doctl', 'expo', 'eas'].includes(c.prog) && (pos[0] === 'login' || (pos[0] === 'auth' && pos[1] === 'login')) && !has(a, '--token', '-t', '--no-localhost', '--ci')) return say(`${c.prog} login`, 'provide a token through the tool\'s documented environment variable')
  if (c.prog === 'aws' && (pos[0] === 'configure' && pos.length === 1 || (pos[0] === 'sso' && pos[1] === 'login'))) return say(`aws ${pos.join(' ')}`, 'use `aws configure set <key> <value>` or environment credentials')
  return undefined
}

const ttyPrompt: Rule = (c, o) => {
  if (!o.pty) return undefined
  const a = c.args
  const pos = positionals(a)
  const yes = has(a, '-y', '--yes', '--assume-yes', '--noconfirm', '--non-interactive', '-n', '-S', '--stdin', '-f', '--force')
  if (c.prog === 'sudo' && !has(a, '-n', '--non-interactive', '-S', '--stdin')) {
    return { reason: '`sudo` waits for a password on the terminal', suggestion: 'use `sudo -n` (fails instead of prompting) or ask the user to run it' }
  }
  if (['apt', 'apt-get', 'dnf', 'yum', 'zypper', 'apk'].includes(c.prog) && ['install', 'remove', 'purge', 'upgrade', 'dist-upgrade', 'full-upgrade', 'autoremove', 'erase', 'update'].includes(pos[0] ?? '') && !yes && !(c.prog === 'apt-get' && pos[0] === 'update') && !(c.prog === 'apk')) {
    if ((c.prog === 'apt' || c.prog === 'apt-get') && pos[0] === 'update') return undefined
    return { reason: `\`${c.prog} ${pos[0]}\` asks for confirmation`, suggestion: `add \`-y\`: \`${c.prog} ${pos[0]} -y ...\`` }
  }
  if (c.prog === 'pacman' && a.some(x => /^-S|^-R|^-U/.test(x)) && !has(a, '--noconfirm')) {
    return { reason: '`pacman` asks for confirmation', suggestion: 'add `--noconfirm`' }
  }
  if ((c.prog === 'npx' || c.prog === 'pnpx') && !has(a, '-y', '--yes', '--no-install', '--no')) {
    return { reason: '`npx` asks before installing a package that is not present', suggestion: 'add `--yes`: `npx --yes <pkg>`' }
  }
  if (['rm', 'cp', 'mv'].includes(c.prog) && has(a, '-i', '--interactive')) {
    return { reason: `\`${c.prog} -i\` asks before each file`, suggestion: 'drop `-i`' }
  }
  return undefined
}

const RULES: Record<RuleId, Rule> = {
  editor, pager, tui, repl, 'remote-shell': remoteShell, 'container-tty': containerTty, 'git-editor': gitEditor,
  'git-interactive': gitInteractive, watch, server, follow, prompt, login, 'tty-prompt': ttyPrompt,
}

const VALUE_WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '--user', '--group']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p']),
  stdbuf: new Set(['-i', '-o', '-e']),
  chrt: new Set([]),
  'xvfb-run': new Set(['-a', '-n', '-s', '-f', '-e']),
  doppler: new Set([]),
  dotenv: new Set(['-e', '-c']),
}

/** Strip wrapper programs; returns undefined when a wrapper bounds the run (e.g. `timeout`). */
function unwrap(argv: string[], env: Record<string, string>): { argv: string[]; env: Record<string, string> } | undefined {
  let words = [...argv]
  const vars = { ...env }
  for (let guard = 0; guard < 10 && words.length > 0; guard += 1) {
    const prog = basename(words[0]!)
    if (prog === 'timeout' || prog === 'gtimeout') return undefined
    if (prog === 'nohup' || prog === 'time' || prog === 'command' || prog === 'exec' || prog === 'builtin' || prog === 'caffeinate' || prog === 'unbuffer' || prog === 'setsid') {
      words = words.slice(1)
      while (words[0]?.startsWith('-')) words = words.slice(1)
      continue
    }
    const valueFlags = VALUE_WRAPPERS[prog]
    if (valueFlags !== undefined) {
      if (prog === 'sudo' && words.length === 1) break
      let i = 1
      while (i < words.length) {
        const w = words[i]!
        if (prog === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
          const eq = w.indexOf('=')
          vars[w.slice(0, eq)] = w.slice(eq + 1)
          i += 1
          continue
        }
        if (valueFlags.has(w)) { i += 2; continue }
        if (w.startsWith('-')) { i += 1; continue }
        break
      }
      if (prog === 'doppler' || prog === 'dotenv') {
        const dash = words.indexOf('--')
        words = dash === -1 ? words.slice(i) : words.slice(dash + 1)
      } else {
        words = words.slice(i)
      }
      if (prog === 'sudo') vars.__SUDO = '1'
      continue
    }
    if (prog === 'npx' || prog === 'pnpx' || prog === 'bunx') {
      let i = 1
      while (i < words.length && words[i]!.startsWith('-')) i += words[i] === '-p' || words[i] === '--package' ? 2 : 1
      if (i >= words.length) break
      words = words.slice(i)
      continue
    }
    if ((prog === 'pnpm' || prog === 'yarn' || prog === 'bun') && (words[1] === 'exec' || words[1] === 'dlx' || words[1] === 'x')) {
      words = words.slice(2)
      while (words[0]?.startsWith('-')) words = words.slice(1)
      continue
    }
    if ((prog === 'uv' || prog === 'poetry' || prog === 'pipenv' || prog === 'pdm' || prog === 'hatch' || prog === 'rye') && words[1] === 'run') {
      words = words.slice(2)
      while (words[0]?.startsWith('-')) words = words.slice(words[0] === '--with' || words[0] === '--python' || words[0] === '-p' ? 2 : 1)
      continue
    }
    if (prog === 'bundle' && words[1] === 'exec') { words = words.slice(2); continue }
    if (prog === 'npm' && (words[1] === 'exec' || words[1] === 'x')) {
      const dash = words.indexOf('--')
      words = dash === -1 ? words.slice(2).filter(w => !w.startsWith('-')) : words.slice(dash + 1)
      continue
    }
    break
  }
  return { argv: words, env: vars }
}

const HELP = new Set(['--help', '--version', '--usage'])
/** Short flags that mean help/version only when they are the sole argument (`-h` is a host flag for psql, mysql, redis-cli). */
const SOLE_HELP = new Set(['-h', '-V', '-v', 'help', 'version'])

/**
 * Analyze a full command line for hanging commands.
 * @param command - raw shell text as the model wrote it.
 * @param options - PTY mode and disabled rules.
 * @returns the first finding, or undefined when nothing would hang.
 */
export function analyzeCommand(command: string, options: AnalyzeOptions, depth = 0): Finding | undefined {
  const disabled = new Set(options.disabledRules ?? [])
  for (const simple of splitCommands(command, options.dialect)) {
    if (simple.backgrounded) continue
    const finding = analyzeSimple(simple, options, disabled, depth)
    if (finding !== undefined) return finding
  }
  return undefined
}

function analyzeSimple(simple: SimpleCommand, options: AnalyzeOptions, disabled: Set<RuleId>, depth: number): Finding | undefined {
  const unwrapped = unwrap(simple.argv, simple.env)
  if (unwrapped === undefined || unwrapped.argv.length === 0) return undefined
  const [first, ...args] = unwrapped.argv
  const prog = basename(first!)
  if (prog === '&' && args.length > 0 && depth < 3) return analyzeSimple({ ...simple, argv: args }, options, disabled, depth + 1)
  if (prog === 'cmd' && depth < 3) {
    const ci = args.findIndex(a => /^\/[ck]$/i.test(a))
    if (ci !== -1 && args.length > ci + 1) return analyzeCommand(args.slice(ci + 1).join(' '), { ...options, dialect: 'posix' }, depth + 1)
  }
  if ((prog === 'pwsh' || prog === 'powershell') && depth < 3) {
    const ci = args.findIndex(a => /^-(?:c|command)$/i.test(a))
    if (ci !== -1 && args.length > ci + 1) return analyzeCommand(args.slice(ci + 1).join(' '), { ...options, dialect: 'powershell' }, depth + 1)
  }
  if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(prog) && depth < 3) {
    const ci = args.findIndex(a => a === '-c' || /^-[a-z]*c$/.test(a))
    if (ci !== -1 && args[ci + 1] !== undefined) return analyzeCommand(args[ci + 1]!, { ...options, dialect: 'posix' }, depth + 1)
  }
  if (args.some(a => HELP.has(a)) || (args.length === 1 && SOLE_HELP.has(args[0]!))) return undefined
  const cmd: Cmd = {
    prog,
    args,
    env: unwrapped.env,
    stdin: simple.stdinProvided,
    piped: simple.stdoutPiped,
    text: simple.text,
  }
  if (cmd.env.__SUDO === '1' && options.pty && !disabled.has('tty-prompt')) {
    const sudoFinding = RULES['tty-prompt']({ ...cmd, prog: 'sudo', args: [] }, options)
    if (sudoFinding !== undefined && !simple.argv.slice(1).some(a => a === '-n' || a === '-S' || a === '--non-interactive' || a === '--stdin')) {
      return { rule: 'tty-prompt', command: simple.text, ...sudoFinding }
    }
  }
  for (const id of RULE_IDS) {
    if (disabled.has(id)) continue
    const result = RULES[id](cmd, options)
    if (result !== undefined) return { rule: id, command: simple.text, ...result }
  }
  return undefined
}
