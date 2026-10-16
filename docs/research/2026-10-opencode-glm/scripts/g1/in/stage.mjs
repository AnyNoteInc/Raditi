// Inside the CLI container, before a turn: puts in place what the host side of the product would.
// stdin: { home, configText, agentsMd, secrets: { llm, mcp }, readonlyConfig, repo, files: { path: text } }
// The two secrets land in /run/raditi/secrets (tmpfs) as files of mode 0600, as the sandbox helper writes them.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const input = JSON.parse(readFileSync(0, 'utf8'))
const home = input.home ?? '/agent-home/opencode'
const configDir = `${home}/.config/opencode`
if (existsSync(configDir)) chmodSync(configDir, 0o755)
mkdirSync(configDir, { recursive: true })
if (input.configText !== undefined) writeFileSync(`${configDir}/opencode.json`, input.configText)
if (input.agentsMd !== undefined) writeFileSync(`${configDir}/AGENTS.md`, input.agentsMd)
for (const [path, text] of Object.entries(input.files ?? {})) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
if (input.secrets) {
  mkdirSync('/run/raditi/secrets', { recursive: true })
  for (const name of ['llm', 'mcp'])
    if (input.secrets[name] !== undefined)
      writeFileSync(`/run/raditi/secrets/${name}`, input.secrets[name], { mode: 0o600 })
}
if (input.repo !== false && !existsSync('/workspace/repo/.git')) {
  mkdirSync('/workspace/repo', { recursive: true })
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: '/workspace/repo',
      stdio: 'ignore',
      env: { ...process.env, HOME: home },
    })
  git('init', '-q', '.')
  git('config', 'user.email', 'stand@example.invalid')
  git('config', 'user.name', 'stand')
  writeFileSync(
    '/workspace/repo/README.md',
    '# Stand repository\n\nSynthetic content for a CLI spike.\n',
  )
  git('add', '.')
  git('commit', '-qm', 'init')
}
// The CLI installs a plugin package into every writable configuration directory; a read-only one stops it.
if (input.readonlyConfig !== false) chmodSync(configDir, 0o555)
console.log(JSON.stringify({ staged: true, configDir }))
