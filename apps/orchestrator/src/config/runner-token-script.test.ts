import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { hashRunnerToken, parseRunnerTokens } from './runner-tokens.ts'

const script = fileURLToPath(new URL('../../scripts/runner-token.mjs', import.meta.url))
const run = promisify(execFile)

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tokenFile() {
  const dir = await mkdtemp(join(tmpdir(), 'raditi-runner-token-'))
  dirs.push(dir)
  return join(dir, 'runner-token')
}

async function runScript(...args: string[]) {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args])
    return { code: 0, stdout: stdout.trim(), stderr }
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string }
    return { code: failed.code, stdout: failed.stdout.trim(), stderr: failed.stderr }
  }
}

// Each case starts Node several times: slow on a loaded machine, not stuck.
describe('runner-token script', { timeout: 30_000 }, () => {
  it('issues a token and prints the production entry bound to the VM address', async () => {
    const file = await tokenFile()
    const issued = await runScript('issue', 'sandbox-1', file, '--ip', '10.10.1.11')
    expect(issued.code).toBe(0)
    const token = (await readFile(file, 'utf8')).trim()
    expect(token).toMatch(/^rnr_sandbox-1\./)
    expect((await stat(file)).mode & 0o777).toBe(0o400)
    expect(issued.stdout).toBe(`sandbox-1:${hashRunnerToken(token)}@10.10.1.11`)
    expect(issued.stdout).not.toContain(token)
    // Exactly what production core accepts from that address.
    const parsed = parseRunnerTokens(issued.stdout, true)
    expect(parsed.problems).toEqual([])
    expect(parsed.hashes.get('sandbox-1')?.[0]?.address).toBe('10.10.1.11')

    expect((await runScript('hash', file, '--ip', 'fd00::12')).stdout).toBe(
      `sandbox-1:${hashRunnerToken(token)}@[fd00::12]`,
    )
    // Outside production an entry without an address still works, with a reminder.
    const bare = await runScript('hash', file)
    expect(bare.stdout).toBe(`sandbox-1:${hashRunnerToken(token)}`)
    expect(bare.stderr).toMatch(/--ip/)
  })

  it('takes only a private IP address literal and never overwrites a token', async () => {
    const file = await tokenFile()
    for (const address of ['8.8.8.8', '127.0.0.1', 'sandbox-1.internal', '10.10.1.11:8083']) {
      const refused = await runScript('issue', 'sandbox-1', file, '--ip', address)
      expect(refused.code).toBe(2)
      expect(refused.stdout).toBe('')
    }
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await runScript('issue', 'sandbox-1', file, '--ip')).code).toBe(2)
    expect((await runScript('issue', 'sandbox-1', file, '--ip', '10.10.1.11')).code).toBe(0)
    const again = await runScript('issue', 'sandbox-1', file, '--ip', '10.10.1.11')
    expect(again.code).toBe(1)
    expect(again.stderr).toMatch(/EEXIST/)
  })
})
