/* global console, process */
// Runner VM tokens (spec §15). The token opens only the turns assigned to its runner; core keeps
// only its SHA-256 in RUNNER_TOKENS=<runner id>:<sha256>,… and the token itself is never printed.
//
//   issue <runner id> <token file>  a new token into <token file> (mode 0400, never overwritten);
//                                   prints the RUNNER_TOKENS entry for core
//   hash <token file>               the RUNNER_TOKENS entry of an existing token
//
// Rotation: issue a new token → add its entry to RUNNER_TOKENS next to the old one (two per
// runner) and restart core → put the file on the VM as RUNNER_TOKEN_FILE (root, 0400, read-only
// mount) and restart the runner → remove the old entry and restart core.
import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import { parseRunnerToken, runnerIdSchema } from '@repo/domain'

const usage = () => {
  console.error(
    'Usage: runner-token issue <runner id> <token file> | runner-token hash <token file>',
  )
  process.exit(2)
}

const entry = (token) => {
  const parsed = parseRunnerToken(token)
  if (!parsed) {
    console.error('The file does not hold a runner token')
    process.exit(1)
  }
  return `${parsed.runnerId}:${createHash('sha256').update(token, 'utf8').digest('hex')}`
}

const [command, ...args] = process.argv.slice(2)
if (command === 'issue') {
  const [runnerId, file] = args
  if (!runnerId || !file || args.length !== 2) usage()
  if (!runnerIdSchema.safeParse(runnerId).success) {
    console.error('A runner id is 1–63 lowercase letters, digits and hyphens')
    process.exit(2)
  }
  const token = `rnr_${runnerId}.${randomBytes(32).toString('base64url')}`
  try {
    await writeFile(file, token, { flag: 'wx', mode: 0o400 })
  } catch (error) {
    console.error(`Could not create the token file (${error.code ?? 'error'})`)
    process.exit(1)
  }
  console.log(entry(token))
} else if (command === 'hash') {
  const [file] = args
  if (!file || args.length !== 1) usage()
  console.log(entry((await readFile(file, 'utf8')).trim()))
} else usage()
