import process from 'node:process'

import { runLlmCommand } from '../src/llm/usage-cli.ts'

try {
  await runLlmCommand('plan-rates', process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
