import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeCommand, type RuleId } from '../src/rules.ts'

const blocked: Array<[string, RuleId]> = [
  ['vim src/index.ts', 'editor'],
  ['nano README.md', 'editor'],
  ['sudo vi /etc/hosts', 'editor'],
  ['cd app && emacs main.c', 'editor'],
  ['code --wait notes.md', 'editor'],
  ['subl -w notes.md', 'editor'],
  ['python', 'repl'],
  ['python3 -i script.py', 'repl'],
  ['node', 'repl'],
  ['psql -h localhost -U postgres mydb', 'repl'],
  ['mysql -u root', 'repl'],
  ['sqlite3 app.db', 'repl'],
  ['redis-cli -h 127.0.0.1', 'repl'],
  ['irb', 'repl'],
  ['bash', 'repl'],
  ['top', 'tui'],
  ['htop', 'tui'],
  ['yes', 'server'],
  ['watch -n 1 kubectl get pods', 'tui'],
  ['tmux attach -t dev', 'tui'],
  ['ssh deploy@prod', 'remote-shell'],
  ['ssh -i key.pem -p 2222 me@host', 'remote-shell'],
  ['ssh -N -L 5432:localhost:5432 bastion', 'remote-shell'],
  ['docker run -it ubuntu bash', 'container-tty'],
  ['docker exec -ti web sh', 'container-tty'],
  ['kubectl exec -it pod-1 -- bash', 'container-tty'],
  ['git commit', 'git-editor'],
  ['git commit -a', 'git-editor'],
  ['git commit --amend', 'git-editor'],
  ['git rebase --continue', 'git-editor'],
  ['git revert HEAD', 'git-editor'],
  ['git tag -a v1.0', 'git-editor'],
  ['git rebase -i HEAD~3', 'git-interactive'],
  ['git add -p', 'git-interactive'],
  ['git mergetool', 'git-interactive'],
  ['npm run dev', 'server'],
  ['pnpm dev', 'server'],
  ['yarn start', 'server'],
  ['npm start', 'server'],
  ['bun run serve', 'server'],
  ['npx vite', 'server'],
  ['next dev -p 3001', 'server'],
  ['python -m http.server 8000', 'server'],
  ['python manage.py runserver', 'server'],
  ['uvicorn app.main:app --reload', 'server'],
  ['flask run', 'server'],
  ['rails s', 'server'],
  ['php artisan serve', 'server'],
  ['docker compose up', 'server'],
  ['docker-compose up --build', 'server'],
  ['jupyter lab', 'server'],
  ['uv run uvicorn main:app', 'server'],
  ['npm run test:watch', 'watch'],
  ['npm test -- --watch', 'watch'],
  ['jest --watchAll', 'watch'],
  ['tsc -w', 'watch'],
  ['nodemon server.js', 'watch'],
  ['vitest watch', 'watch'],
  ['cargo watch -x test', 'watch'],
  ['ng test', 'watch'],
  ['tail -f logs/app.log', 'follow'],
  ['tail -F /var/log/syslog', 'follow'],
  ['journalctl -u nginx -f', 'follow'],
  ['docker logs -f web', 'follow'],
  ['kubectl logs -f deploy/api', 'follow'],
  ['kubectl port-forward svc/db 5432', 'follow'],
  ['ping google.com', 'follow'],
  ['nc -l 8080', 'follow'],
  ['npm init', 'prompt'],
  ['ssh-keygen -t ed25519', 'prompt'],
  ['crontab -e', 'prompt'],
  ['gh auth login', 'login'],
  ['npm login', 'login'],
  ['az login', 'login'],
  ['docker login ghcr.io', 'login'],
  ['bash -c "npm run dev"', 'server'],
  ['FOO=1 npm run dev', 'server'],
  ['npm install && npm run dev', 'server'],
]

const allowed: string[] = [
  'ls -la',
  'vim --version',
  'python script.py',
  'python -c "print(1)"',
  'python -m pytest -q',
  'python - <<EOF\nprint(1)\nEOF',
  'echo "select 1" | psql mydb',
  'psql -c "select 1" mydb',
  'mysql -e "show tables" app',
  'sqlite3 app.db "select count(*) from users"',
  'redis-cli PING',
  'node index.js',
  'node -e "console.log(1)"',
  'top -b -n 1',
  'top -bn1',
  'npm run dev:build',
  'pnpm run start:migrate',
  'jest --watchAll=false',
  'yes | npx shadcn@latest init',
  'code src/app.ts',
  'ssh host uptime',
  'ssh -o BatchMode=yes host "ls /srv"',
  'docker run --rm ubuntu echo hi',
  'docker exec web ls',
  'git commit -m "fix: thing"',
  'git commit -am "wip"',
  'git commit --amend --no-edit',
  'GIT_EDITOR=true git rebase --continue',
  'git -c core.editor=true rebase -i HEAD~2',
  'git revert --no-edit HEAD',
  'git log --oneline -n 5',
  'git add -A',
  'npm run build',
  'npm test',
  'pnpm test -- --run',
  'npx vitest run',
  'vitest run',
  'jest --ci',
  'tsc --noEmit',
  'vite build',
  'docker compose up -d',
  'docker compose up --wait',
  'tail -n 100 app.log',
  'ping -c 4 google.com',
  'npm run dev &',
  'nohup npm run dev > dev.log 2>&1 &',
  'timeout 10 npm run dev',
  'npm init -y',
  'ssh-keygen -t ed25519 -f key -N ""',
  'echo "$TOKEN" | gh auth login --with-token',
  'docker login -u me --password-stdin ghcr.io',
  'cat README.md | less',
  'less README.md',
  'man git',
  'sudo apt install -y curl',
  'apt-get install curl',
  'bash scripts/setup.sh',
  'bash -c "echo hi"',
  'npm run dev -- --help',
  'echo "vim is great"',
  "grep -r 'npm run dev' docs",
  'kubectl logs deploy/api --tail 50',
  'pnpm install',
  'yarn add lodash',
  'git status',
  'make test',
  'cargo test',
  'go test ./...',
]

for (const [cmd, rule] of blocked) {
  test(`blocks: ${cmd}`, () => {
    const finding = analyzeCommand(cmd, { pty: false })
    assert.ok(finding, `expected ${rule}`)
    assert.equal(finding.rule, rule)
    assert.ok(finding.suggestion.length > 0)
  })
}

for (const cmd of allowed) {
  test(`allows: ${cmd.split('\n')[0]}`, () => {
    assert.equal(analyzeCommand(cmd, { pty: false }), undefined)
  })
}

test('pty mode enables pager and prompt rules', () => {
  assert.equal(analyzeCommand('less README.md', { pty: true })?.rule, 'pager')
  assert.equal(analyzeCommand('sudo apt install curl', { pty: true })?.rule, 'tty-prompt')
  assert.equal(analyzeCommand('sudo -n systemctl restart nginx', { pty: true }), undefined)
  assert.equal(analyzeCommand('vitest', { pty: true })?.rule, 'watch')
  assert.equal(analyzeCommand('vitest', { pty: false }), undefined)
})

test('disabledRules turns a rule off', () => {
  assert.equal(analyzeCommand('npm run dev', { pty: false, disabledRules: ['server'] }), undefined)
})
