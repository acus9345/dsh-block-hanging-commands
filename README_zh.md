# dsh-block-hanging-commands

[English](README.md) | 中文

用智能体用久了，你大概见过这种情况：它运行了不带 `-m` 的 `git commit`，或者 `npm run dev`，或者只敲了一个 `python3`，然后这一轮就卡在那里。命令在等键盘输入，可没有人在打字。通常工具调用会超时，模型什么也没学到，接着又试一个同样糟糕的命令。

这个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件会在每条 shell 命令运行前先读一遍。如果命令会等待输入或者永远不退出，就不运行它，并告诉模型原因和该改用什么，模型在同一步里就能改好（提示是英文的，模型能看懂）：

```
dsh-block-hanging-commands stopped `git commit` before it ran, because `git commit`
without a message opens an editor, so the tool call would just sit there until it timed out.
Instead: pass the message: `git commit -m "<message>"` (or `--no-edit` when amending).
(rule: git-editor)
```

## 安装

```sh
dsh plugin --profile web add dsh-block-hanging-commands
```

这里用的是 `web` 配置（profile），也就是用 `dsh web` 打开的浏览器界面。如果你用别的方式运行 DSH，就换成 `headless`（脚本和 CI）或 `acp`（编辑器集成）。每个配置有自己的插件列表，你用到哪个就装到哪个。不需要别的设置，插件自带配置层，装好就生效。

卸载：`dsh plugin --profile web remove dsh-block-hanging-commands`。

### 从源码安装

想试本地改动的话，打个包再装：

```sh
git clone https://github.com/acus9345/dsh-block-hanging-commands
cd dsh-block-hanging-commands
npm install
npm pack
dsh plugin --profile web add ./dsh-block-hanging-commands-0.2.0.tgz
```

## 它会拦截什么

| 规则 | 例子 | 让模型改用什么 |
| --- | --- | --- |
| `editor` | `vim`、`nano`、`emacs`、`code --wait`、`subl -w` | 用编辑工具或 `sed -i` |
| `git-editor` | 不带 `-m` 的 `git commit` 或 `git tag -a` | 加上 `-m` / `--no-edit` |
| `git-interactive` | `git rebase -i`、`git add -p` | 普通 rebase，或用 `GIT_SEQUENCE_EDITOR=:` 配合 `--autosquash`；`git add <路径>` |
| `repl` | `python`、`node`、`psql mydb`、`redis-cli`、`sqlite3 db` | `-c "..."`、脚本文件或 heredoc |
| `server` | `npm run dev`、`vite`、`next dev`、`flask run`、`rails s` | `run_in_background: true`，或 `timeout` |
| `watch` | `jest --watch`、`tsc -w`、`cargo watch`、`nodemon` | 去掉 watch 参数，只跑一次 |
| `follow` | `tail -f`、`journalctl -f`、`kubectl logs -f`、`docker logs -f` | `tail -n 200`、`--since` |
| `remote-shell` | 不带命令的 `ssh host` | 带上要执行的命令；`-o BatchMode=yes` |
| `container-tty` | `docker run -it`、`docker exec -it`、`kubectl exec -it` | 去掉 `-it` |
| `tui` | `htop`、`top`、`lazygit`、`tig`、`ncdu` | 批处理版本（`top -bn1`、`git log`） |
| `prompt` / `login` | 不带 `-y` 的 `npm init`、`crontab -e`、`gh auth login`、`aws configure` | 非交互参数，或者去问用户 |
| `pager`、`tty-prompt` | `less file`、要密码的 `sudo` | 只在 PTY shell 上检查，见下文 |

它能看穿常见的包装（`sudo`、`env`、`nohup`、`npx`、`pnpm exec`、`uv run`、`bash -c '...'`），也能处理管道、`&&` 串联、heredoc 和重定向。所以 `cd app && npm run dev` 会被拦住，而 `echo q | python3` 和 `python3 < script.py` 不会，因为它们的输入已经给好了。`timeout 30 npm run dev` 会放行，带 `run_in_background: true` 的调用也会放行，因为这两种情况下命令迟早会结束或者转到后台。开发服务器、watch 或 `tail -f` 如果用了 shell 工具自带的 `timeoutMs`，同样放行，效果一样。但编辑器或会提问的命令仍然会被拦住，因为超时只会让它在后台继续等。

它在 Windows 上也能用。Windows 上 DSH 用 PowerShell（`pwsh`）而不是 bash 运行命令，插件也认识 `npm.cmd`、`C:\Python312\python.exe` 这样的完整路径、`&` 调用符和 `Get-Content -Wait`。

我尽量减少误报。`psql -c "select 1"`、`node script.js`、`vim -es`、`git commit -F msg.txt`、`top -bn1`、`ssh host uptime`，以及任何命令的 `--help` / `--version` 都会放行。

## 设置

最简单的办法：在 DSH 侧边栏打开 **插件**，点 **dsh-block-hanging-commands**，改好后点 **保存**。下一次工具调用就生效，不用重启。

或者在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加一行这样的配置（只影响一个配置），或者加到 `~/.dsh/cordis.patch.yml`（影响所有配置）。没写的项保持默认值。

```yaml
- id: block-hanging-commands
  config:
    mode: deny             # 或 `ask`，改为弹出审批而不是直接拒绝
    tools: [bash, pwsh]    # 要检查的 shell 工具名（pwsh 是 Windows 上的 shell）
    pty: false             # 如果你的 shell 工具跑在 PTY 上（dsh-tool-bash-persistent），设为 true
    disabledRules: []      # 比如 [server]，如果你确实想让模型启动开发服务器
    allowPatterns: []      # 正则表达式，比如 ['^make serve$']
```

`pty` 之所以重要，是因为没有终端时，`less` 和 `git log` 不会分页，`sudo` 会直接失败而不是提示输入密码。所以这些规则只在 shell 真的是 PTY 时才启用。

## 工作原理

插件挂在 `tools/pre-execute` 上。它自己解析命令（不会启动 shell），把每条简单命令和规则对比，匹配上就返回 `deny` 和原因。什么都不会运行，也不会改写命令。下一步怎么做仍然由模型决定，只是它手里的信息更准确了。

## 开发

```sh
npm install
npm test           # 命令解析和规则的单元测试
npm run test:e2e   # 用脚本模拟的本地模型启动真实的 dsh，不需要 API Key
```

安装测试会执行 `dsh plugin add`，需要 PATH 里有 `pnpm`。

e2e 测试还会像用户一样打包插件，再用 `dsh plugin add` 安装，确保发布出去的包真的能加载。

MIT 许可。作者 [acus9345](https://github.com/acus9345)。欢迎在 issues 里报 bug 或提想法。
