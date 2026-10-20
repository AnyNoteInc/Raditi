import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { hashRunnerToken, parseRunnerTokens } from '../config/runner-tokens.ts'
import { RunnerAuthenticator } from './runner-auth.ts'

const run = promisify(execFile)
// The operator script lives with the runner (its image issues the token on the VM): this test
// runs it as a program and checks that core accepts what it prints.
const script = new URL('../../../runner/scripts/runner-token.mjs', import.meta.url).pathname
const token = (id: string, fill: string) => `rnr_${id}.${fill.repeat(43)}`
const bearer = (value: string) => `Bearer ${value}`
const vm = '10.20.0.11'

function authenticator(...tokens: string[]) {
  const { hashes, problems } = parseRunnerTokens(
    tokens
      .map((value) => `${value.slice(4, value.indexOf('.'))}:${hashRunnerToken(value)}`)
      .join(','),
  )
  expect(problems).toEqual([])
  return new RunnerAuthenticator(hashes, { warn: vi.fn() })
}

describe('RunnerAuthenticator', () => {
  it('knows a runner by the hash of its whole token only', () => {
    const current = token('sandbox-1', 'a')
    const auth = authenticator(current)
    expect(auth.authenticate(bearer(current), vm)).toBe('sandbox-1')
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
      expect(auth.authenticate(header, vm)).toBeNull()
  })

  it('accepts both tokens of a runner during rotation and none once revoked', () => {
    const old = token('sandbox-1', 'a')
    const next = token('sandbox-1', 'b')
    const rotating = authenticator(old, next)
    expect(rotating.authenticate(bearer(old), vm)).toBe('sandbox-1')
    expect(rotating.authenticate(bearer(next), vm)).toBe('sandbox-1')
    const rotated = authenticator(next)
    expect(rotated.authenticate(bearer(old), vm)).toBeNull()
    expect(rotated.authenticate(bearer(next), vm)).toBe('sandbox-1')
    // Another runner's token never opens this one.
    expect(authenticator(token('sandbox-2', 'c')).authenticate(bearer(next), vm)).toBeNull()
  })

  it('accepts a bound token only from its VM address, logging the runner and the address only', () => {
    const current = token('sandbox-1', 'a')
    const next = token('sandbox-1', 'b')
    const warn = vi.fn()
    const { hashes } = parseRunnerTokens(
      `sandbox-1:${hashRunnerToken(current)}@${vm},sandbox-1:${hashRunnerToken(next)}@fd00::11`,
      true,
    )
    const auth = new RunnerAuthenticator(hashes, { warn })
    expect(auth.authenticate(bearer(current), vm)).toBe('sandbox-1')
    // A dual-stack socket reports IPv4 peers as IPv4-mapped IPv6.
    expect(auth.authenticate(bearer(current), `::ffff:${vm}`)).toBe('sandbox-1')
    expect(auth.authenticate(bearer(next), 'fd00:0::11')).toBe('sandbox-1')
    expect(warn).not.toHaveBeenCalled()

    // The right token from elsewhere, or with each rotation hash swapped: refused.
    for (const [value, from] of [
      [current, '10.20.0.12'],
      [current, 'fd00::11'],
      [next, vm],
      [current, undefined],
    ] as const)
      expect(auth.authenticate(bearer(value), from)).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    const line = String(warn.mock.calls[0]![0])
    expect(line).toBe('runner sandbox-1: token from another address 10.20.0.12')
    expect(line).not.toContain(current.slice(current.indexOf('.') + 1))
  })
})

// Each case starts Node several times: slow on a loaded machine, not stuck.
describe('scripts/runner-token.mjs', { timeout: 30_000 }, () => {
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

    // The parser and the authenticator take the printed entry as is. loadConfig does not: with
    // TURN_EXECUTOR=runner a turn key is bound to its runner's address, so every entry needs
    // `@<IP>` (locally @127.0.0.1). The entry names no address, and the script says so.
    const { hashes } = parseRunnerTokens(issued.stdout.trim())
    expect(new RunnerAuthenticator(hashes, { warn: vi.fn() }).authenticate(bearer(value), vm)).toBe(
      'sandbox-1',
    )
    expect(issued.stderr).toMatch(/--ip/)
    expect(issued.stderr).toMatch(/@127\.0\.0\.1/)
    expect(issued.stderr).not.toMatch(/accepted/)
  })

  it('prints the production entry bound to the private address of the VM', async () => {
    dir = await mkdtemp(join(tmpdir(), 'raditi-runner-token-'))
    const file = join(dir, 'runner.token')
    const issued = await run(process.execPath, [script, 'issue', 'sandbox-1', file, '--ip', vm])
    const value = await readFile(file, 'utf8')
    expect(issued.stdout).toBe(`sandbox-1:${hashRunnerToken(value)}@${vm}\n`)
    expect(issued.stderr).toBe('')
    // Exactly what production core takes, and the token opens the API only from that address.
    const { hashes, problems } = parseRunnerTokens(issued.stdout.trim(), true)
    expect(problems).toEqual([])
    const auth = new RunnerAuthenticator(hashes, { warn: vi.fn() })
    expect(auth.authenticate(bearer(value), vm)).toBe('sandbox-1')
    expect(auth.authenticate(bearer(value), '10.20.0.12')).toBeNull()
    expect((await run(process.execPath, [script, 'hash', file, '--ip', 'fd00::12'])).stdout).toBe(
      `sandbox-1:${hashRunnerToken(value)}@[fd00::12]\n`,
    )
  })

  it('takes only a private IP address literal for --ip', async () => {
    dir = await mkdtemp(join(tmpdir(), 'raditi-runner-token-'))
    const file = join(dir, 'runner.token')
    for (const address of ['8.8.8.8', '127.0.0.1', 'sandbox-1.internal', `${vm}:8083`, undefined])
      await expect(
        run(process.execPath, [
          script,
          'issue',
          'sandbox-1',
          file,
          '--ip',
          ...(address ? [address] : []),
        ]),
      ).rejects.toMatchObject({ code: 2, stdout: '' })
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an invalid runner id', async () => {
    dir = await mkdtemp(join(tmpdir(), 'raditi-runner-token-'))
    await expect(
      run(process.execPath, [script, 'issue', 'Sandbox_1', join(dir, 'token')]),
    ).rejects.toMatchObject({ code: 2 })
  })
})
