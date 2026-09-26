// Every variable in .env.example must be listed in turbo.json globalEnv:
// turbo runs tasks in strict env mode and drops undeclared variables.
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const declared = readFileSync(new URL('.env.example', root), 'utf8')
  .split('\n')
  .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
  .filter(Boolean)
const globalEnv = new Set(JSON.parse(readFileSync(new URL('turbo.json', root), 'utf8')).globalEnv)

const missing = declared.filter((name) => !globalEnv.has(name))
if (missing.length > 0) {
  console.error(`turbo.json globalEnv is missing: ${missing.join(', ')}`)
  process.exit(1)
}
console.log(`env ok: ${declared.length} variables from .env.example are in turbo.json globalEnv`)
