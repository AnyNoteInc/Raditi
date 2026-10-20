import process from 'node:process'

import { runBillingCommand } from '../src/billing/operator-cli.ts'

try {
  await runBillingCommand('stop-renewal', process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
