import process from 'node:process'

import { runOriPorts } from '../src/operator/ori-ports-cli.ts'

try {
  await runOriPorts(process.stdin)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
