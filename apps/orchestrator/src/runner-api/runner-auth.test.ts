import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { hashRunnerToken, parseRunnerTokens } from '../config/runner-tokens.ts'
import { RunnerAuthenticator } from './runner-auth.ts'

const run = promisify(execFile)
const script = new URL('../../scripts/runner-token.mjs', import.meta.url).pathname
const token = (id: string, fill: string) => `rnr_${id}.${fill.repeat(43)}`
const bearer = (value: string) => `Bearer ${value}`

function authenticator(...tokens: string[]) {
  const { hashes, problems } = parseRunnerTokens(
    tokens
      .map((value) => `${value.slice(4, value.indexOf('.'))}:${hashRunnerToken(value)}`)
      .join(','),
  )
  expect(problems).toEqual([])
  return new RunnerAuthenticator(hashes)
}

describe('RunnerAuthenticator', () => {
  it('knows a runner by the hash of its whole token only', () => {
    const current = token('sandbox-1', 'a')
    const auth = authenticator(current)
    expect(auth.authenticate(bearer(current))).toBe('sandbox-1')
    for (const header of [
      undefined,
      '',
      current,
      `Basic ${current}`,
      bearer(token('sandbox-1', 'b')),
      bearer(token('sandbox-2', 'a')),
      bearer(`${current} `),
      bearer(current.slice(0, -1)),
      bearer(`${current}x`.repeat(8)),
    ])
      expect(auth.authenticate(header)).toBeNull()
  })

  it('accepts both tokens of a runner during rotation and none once revoked', () => {
    const old = token('sandbox-1', 'a')
    const next = token('sandbox-1', 'b')
    const rotating = authenticator(old, next)
    expect(rotating.authenticate(bearer(old))).toBe('sandbox-1')
    expect(rotating.authenticate(bearer(next))).toBe('sandbox-1')
    const rotated = authenticator(next)
    expect(rotated.authenticate(bearer(old))).toBeNull()
    expect(rotated.authenticate(bearer(next))).toBe('sandbox-1')
    // Another runner's token never opens this one.
    expect(authenticator(token('sandbox-2', 'c')).authenticate(bearer(next))).toBeNull()
  })
})

describe('scripts/runner-token.mjs', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('issues a token only into a new owner-only file and prints just its entry', async () => {
    dir = await mkdtemp(join(tmpdir(), 'raditi-runner-token-'))
    const file = join(dir, 'runner.token')
    const issued = await run(process.execPath, [script, 'issue', 'sandbox-1', file])
    const value = await readFile(file, 'utf8')
    expect((await stat(file)).mode & 0o777).toBe(0o400)
    expect(issued.stdout).toBe(`sandbox-1:${hashRunnerToken(value)}\n`)
    expect(issued.stdout + issued.stderr).not.toContain(value.slice(value.indexOf('.') + 1))
    expect((await run(process.execPath, [script, 'hash', file])).stdout).toBe(issued.stdout)
    await expect(run(process.execPath, [script, 'issue', 'sandbox-1', file])).rejects.toMatchObject(
      { code: 1 },
    )
    expect(await readFile(file, 'utf8')).toBe(value)

    // The printed entry is what core needs: RUNNER_TOKENS takes it as is.
    const { hashes } = parseRunnerTokens(issued.stdout.trim())
    expect(new RunnerAuthenticator(hashes).authenticate(bearer(value))).toBe('sandbox-1')
  })

  it('refuses an invalid runner id', async () => {
    dir = await mkdtemp(join(tmpdir(), 'raditi-runner-token-'))
    await expect(
      run(process.execPath, [script, 'issue', 'Sandbox_1', join(dir, 'token')]),
    ).rejects.toMatchObject({ code: 2 })
  })
})
