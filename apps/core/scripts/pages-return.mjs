import process from 'node:process'

import { runPagesCommand } from '../src/pages/operator-cli.ts'

try {
  await runPagesCommand('return', process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
