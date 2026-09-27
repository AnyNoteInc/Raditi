/* global console, process */
// Runner VM tokens (spec §15). The token opens only the turns assigned to its runner; core keeps
// only its SHA-256 in RUNNER_TOKENS=<runner id>:<sha256>@<VM private IP>,… and the token itself
// is never printed.
//
//   issue <runner id> <token file> --ip <VM private IP>
//                                   a new token into <token file> (mode 0400, never overwritten);
//                                   prints the RUNNER_TOKENS entry for core
//   hash <token file> --ip <VM private IP>
//                                   the RUNNER_TOKENS entry of an existing token
//
// Production binds each hash to the private address of its VM: --ip takes an RFC 1918 or IPv6
// ULA literal, never a name. Without --ip the entry is accepted only outside production.
// Rotation: infra/app/README.md, «Токены раннеров».
import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import { parseRunnerToken, runnerIdSchema } from '@repo/domain'

import { ipLiteral, isPrivateAddress } from '../src/config/private-address.ts'

const usage = () => {
  console.error(
    'Usage: runner-token issue <runner id> <token file> [--ip <VM private IP>]\n' +
      '       runner-token hash <token file> [--ip <VM private IP>]',
  )
  process.exit(2)
}

/** `--ip <address>` anywhere after the command: the address bound to the hash. */
function options(args) {
  const index = args.indexOf('--ip')
  if (index < 0) return { rest: args, address: undefined }
  const written = args[index + 1]
  if (written === undefined) usage()
  const rest = args.filter((_, at) => at !== index && at !== index + 1)
  if (rest.includes('--ip')) usage()
  if (!isPrivateAddress(written)) {
    console.error('--ip takes the private IP address of the VM (RFC 1918 or IPv6 ULA), not a name')
    process.exit(2)
  }
  const literal = ipLiteral(written)
  return { rest, address: literal.includes(':') ? `[${literal}]` : literal }
}

const entry = (token, address) => {
  const parsed = parseRunnerToken(token)
  if (!parsed) {
    console.error('The file does not hold a runner token')
    process.exit(1)
  }
  const hash = createHash('sha256').update(token, 'utf8').digest('hex')
  if (address === undefined)
    console.error('Without --ip the entry is accepted only outside production')
  return `${parsed.runnerId}:${hash}${address === undefined ? '' : `@${address}`}`
}

const [command, ...all] = process.argv.slice(2)
const { rest: args, address } = options(all)
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
  console.log(entry(token, address))
} else if (command === 'hash') {
  const [file] = args
  if (!file || args.length !== 1) usage()
  console.log(entry((await readFile(file, 'utf8')).trim(), address))
} else usage()
