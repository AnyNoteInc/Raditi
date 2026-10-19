import process from 'node:process'

import { runReleasesCommand } from '../src/releases/operator-cli.ts'

try {
  await runReleasesCommand('resolve', process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
