import process from 'node:process'

import { runArtifactsCommand } from '../src/artifacts/operator-cli.ts'

try {
  await runArtifactsCommand('take-down', process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
