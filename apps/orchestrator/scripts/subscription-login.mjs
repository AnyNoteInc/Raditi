import process from 'node:process'

import { runSubscriptionCommand } from '../src/subscriptions/cli.ts'

try {
  await runSubscriptionCommand('login', process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
