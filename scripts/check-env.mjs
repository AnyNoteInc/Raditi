// Every variable in .env.example must reach the tasks that read it: turbo runs tasks in strict
// env mode and drops undeclared variables. globalEnv holds only what every task depends on
// (APP_ENV, CI, NODE_ENV); the rest is declared in `env` of the tasks that read it (`test`), so a
// changed variable no longer invalidates typecheck, lint and build. A variable is declared when
// it is in globalEnv or in `env` of any task.
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const declared = readFileSync(new URL('.env.example', root), 'utf8')
  .split('\n')
  .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
  .filter(Boolean)
const turbo = JSON.parse(readFileSync(new URL('turbo.json', root), 'utf8'))
const known = new Set([
  ...(turbo.globalEnv ?? []),
  ...Object.values(turbo.tasks ?? {}).flatMap((task) => task.env ?? []),
])

const missing = declared.filter((name) => !known.has(name))
if (missing.length > 0) {
  console.error(
    `turbo.json declares neither in globalEnv nor in env of a task: ${missing.join(', ')}`,
  )
  process.exit(1)
}
console.log(
  `env ok: ${declared.length} variables from .env.example are in turbo.json globalEnv or tasks.*.env`,
)
