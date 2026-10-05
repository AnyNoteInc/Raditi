import process from 'node:process'

import { runSubscriptionCommand } from '../src/subscriptions/cli.ts'

try {
  await runSubscriptionCommand('retire', process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
