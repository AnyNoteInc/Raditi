import process from 'node:process'

import { runOriExport } from '../src/operator/ori-export-cli.ts'

try {
  await runOriExport(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
