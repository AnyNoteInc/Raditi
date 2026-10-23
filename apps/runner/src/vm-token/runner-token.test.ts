import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readRunnerToken, runnerIdOf } from './runner-token.ts'

const token = `rnr_sandbox-1.${'a'.repeat(43)}`
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'raditi-runner-token-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function tokenFile(content: string, mode: number): Promise<string> {
  const path = join(dir, 'runner-token')
  await writeFile(path, content, { mode })
  return path
}

describe('readRunnerToken', () => {
  it('reads the token of an owner-only file', async () => {
    expect(await readRunnerToken(await tokenFile(`${token}\n`, 0o400), 'production')).toBe(token)
  })

  it('refuses a file others may read in production only', async () => {
    const path = await tokenFile(token, 0o644)
    await expect(readRunnerToken(path, 'production')).rejects.toThrow(
      'RUNNER_TOKEN_FILE: must be readable by its owner only (0400)',
    )
    expect(await readRunnerToken(path, 'development')).toBe(token)
  })

  it('names the variable and a cause, never the content', async () => {
    const leaked = 'rnr_Sandbox.not-a-token'
    await expect(readRunnerToken(await tokenFile(leaked, 0o400), 'test')).rejects.toThrow(
      'RUNNER_TOKEN_FILE: does not hold a runner token',
    )
    await expect(readRunnerToken(join(dir, 'missing'), 'test')).rejects.toThrow(
      'RUNNER_TOKEN_FILE: cannot open the token file (ENOENT)',
    )
    await expect(readRunnerToken(dir, 'test')).rejects.toThrow(
      'RUNNER_TOKEN_FILE: not a regular file',
    )
  })
})

describe('runnerIdOf', () => {
  it('names the runner id of a VM token, never the token in a refusal', () => {
    expect(runnerIdOf(token)).toBe('sandbox-1')
    expect(() => runnerIdOf('rnr_Sandbox.not-a-token')).toThrow(
      'RUNNER_TOKEN_FILE: does not hold a runner token',
    )
  })
})
