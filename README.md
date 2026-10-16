# dsh-block-hanging-commands

English | [中文](README_zh.md)

If you've used an agent for a while you've probably seen this. It runs `git commit` without `-m`, or `npm run dev`, or `python3` with nothing after it, and the turn just sits there. The command is waiting for a keyboard nobody is typing on. Usually the tool times out, the model learns nothing, and then it tries something just as bad.

This plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) reads each shell command before it runs. If the command would wait for input or never exit, it doesn't run it. The model gets told why and what to run instead, so it can fix the call in the same step.

```
dsh-block-hanging-commands stopped `git commit` before it ran, because `git commit`
without a message opens an editor, so the tool call would just sit there until it timed out.
Instead: pass the message: `git commit -m "<message>"` (or `--no-edit` when amending).
(rule: git-editor)
```

## Install

```sh
dsh plugin --profile web add dsh-block-hanging-commands
```

That's the `web` profile, the browser UI you start with `dsh web`. If you run DSH another way, use `headless` (scripts and CI) or `acp` (editor integrations) instead. Each profile keeps its own plugin list, so add it to every profile you use. That's all the setup there is. The plugin ships its own patch layer, so it's on as soon as it's installed.

To remove it: `dsh plugin --profile web remove dsh-block-hanging-commands`.

### From a clone

To try local changes, build a tarball and install that:

```sh
git clone https://github.com/acus9345/dsh-block-hanging-commands
cd dsh-block-hanging-commands
npm install
npm pack
dsh plugin --profile web add ./dsh-block-hanging-commands-0.2.0.tgz
```

## What it catches

| Rule | Examples | What the model is told to do instead |
| --- | --- | --- |
| `editor` | `vim`, `nano`, `emacs`, `code --wait`, `subl -w` | use the edit tools or `sed -i` |
| `git-editor` | `git commit` or `git tag -a` without `-m` | pass `-m` / `--no-edit` |
| `git-interactive` | `git rebase -i`, `git add -p` | a plain rebase or `--autosquash` with `GIT_SEQUENCE_EDITOR=:`; `git add <path>` |
| `repl` | `python`, `node`, `psql mydb`, `redis-cli`, `sqlite3 db` | `-c "..."`, a script file, or a heredoc |
| `server` | `npm run dev`, `vite`, `next dev`, `flask run`, `rails s` | `run_in_background: true`, or `timeout` |
| `watch` | `jest --watch`, `tsc -w`, `cargo watch`, `nodemon` | run once without the watch flag |
| `follow` | `tail -f`, `journalctl -f`, `kubectl logs -f`, `docker logs -f` | `tail -n 200`, `--since` |
| `remote-shell` | `ssh host` with no command | pass the command; `-o BatchMode=yes` |
| `container-tty` | `docker run -it`, `docker exec -it`, `kubectl exec -it` | drop `-it` |
| `tui` | `htop`, `top`, `lazygit`, `tig`, `ncdu` | the batch version (`top -bn1`, `git log`) |
| `prompt` / `login` | `npm init` without `-y`, `crontab -e`, `gh auth login`, `aws configure` | the non-interactive flags, or ask the user |
| `pager`, `tty-prompt` | `less file`, `sudo` asking for a password | only on a PTY shell, see below |

It looks through the usual wrappers (`sudo`, `env`, `nohup`, `npx`, `pnpm exec`, `uv run`, `bash -c '...'`) and handles pipes, `&&` chains, heredocs and redirects. So `cd app && npm run dev` is caught, but `echo q | python3` and `python3 < script.py` are not, because their input is already there. `timeout 30 npm run dev` gets through, and so does any call made with `run_in_background: true`. In both cases the command is going to end or detach anyway. A dev server, watcher or `tail -f` called with the shell tool's own `timeoutMs` also gets through, since that bounds it the same way. An editor or prompt still doesn't, because a timeout just leaves it waiting in the background.

It works on Windows too, where DSH runs commands through PowerShell (`pwsh`) instead of bash. There it also knows `npm.cmd`, full paths like `C:\Python312\python.exe`, the `&` call operator and `Get-Content -Wait`.

I tried hard to keep false positives down. `psql -c "select 1"`, `node script.js`, `vim -es`, `git commit -F msg.txt`, `top -bn1`, `ssh host uptime` and `--help` / `--version` on anything all pass.

## Settings

The easy way: open **Plugins** in DSH's sidebar, click **dsh-block-hanging-commands**, change what you want and press **Save**. It applies to the next tool call, no restart needed.

Or put a row like this in `~/.dsh/profiles/<profile>/cordis.patch.yml`, or in `~/.dsh/cordis.patch.yml` to cover every profile. Keys you leave out keep their defaults.

```yaml
- id: block-hanging-commands
  config:
    mode: deny             # or `ask` to get an approval prompt instead of a refusal
    tools: [bash, pwsh]    # shell tool names to inspect (pwsh is the Windows shell)
    pty: false             # set true if your shell tool runs on a PTY (dsh-tool-bash-persistent)
    disabledRules: []      # e.g. [server] if you really want the model starting dev servers
    allowPatterns: []      # regexes, e.g. ['^make serve$']
```

`pty` matters because without a terminal, `less` and `git log` don't page, and `sudo` fails instead of prompting. So those rules only switch on when the shell really is a PTY.

## How it works

The plugin hooks `tools/pre-execute`. It tokenises the command itself (no shell is spawned), checks each simple command against the rules, and returns `deny` with the reason text if one matches. Nothing runs and nothing is rewritten. The model still decides what to do next. It's just deciding with better information.

## Development

```sh
npm install
npm test           # unit tests for the command parser and rules
npm run test:e2e   # boots real dsh against a scripted local model, no API key needed
```

The install test runs `dsh plugin add`, which needs `pnpm` on your PATH.

The e2e suite also packs the plugin and installs it with `dsh plugin add`, the same way a user would, to make sure the published package actually loads.

MIT licensed. Written by [acus9345](https://github.com/acus9345). Bug reports and ideas are welcome in the issues.
