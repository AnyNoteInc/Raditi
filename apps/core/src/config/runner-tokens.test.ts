import { describe, expect, it } from 'vitest'

import { parseRunnerTokens, runnerCredentialAddress } from './runner-tokens.ts'

const a = 'a'.repeat(64)
const b = 'B'.repeat(64)

describe('parseRunnerTokens', () => {
  it('binds issuance to the same configured address across token rotation', () => {
    const { hashes } = parseRunnerTokens(
      `sandbox-1:${a}@10.20.0.11,sandbox-1:${b}@::ffff:10.20.0.11`,
    )
    expect(runnerCredentialAddress(hashes, 'sandbox-1')).toBe('10.20.0.11')
  })

  it('refuses absent, unbound and inconsistent VM addresses without echoing identity', () => {
    for (const raw of [
      '',
      `sandbox-1:${a}`,
      `sandbox-1:${a}@10.20.0.11,sandbox-1:${b}`,
      `sandbox-1:${a}@10.20.0.11,sandbox-1:${b}@10.20.0.12`,
    ]) {
      const { hashes } = parseRunnerTokens(raw)
      expect(() => runnerCredentialAddress(hashes, 'sandbox-1')).toThrow(
        'Runner credential source unavailable',
      )
    }
  })
  it('reads id:sha256 with an optional VM address in one canonical form', () => {
    const { hashes, problems } = parseRunnerTokens(
      ` sandbox-1:${a}@10.20.0.11, sandbox-1:${b}@::ffff:10.20.0.11 ,sandbox-2:${a}@[FD00:0::12],sandbox-3:${a}`,
    )
    expect(problems).toEqual([])
    expect(
      Object.fromEntries(
        [...hashes].map(([id, entries]) => [
          id,
          entries.map(({ digest, address }) => [digest.toString('hex'), address]),
        ]),
      ),
    ).toEqual({
      'sandbox-1': [
        [a, '10.20.0.11'],
        ['b'.repeat(64), '10.20.0.11'],
      ],
      'sandbox-2': [[a, 'fd00::12']],
      'sandbox-3': [[a, undefined]],
    })
  })

  it('refuses a malformed address, naming the entry only', () => {
    for (const entry of [
      `sandbox-1:${a}@`,
      `sandbox-1:${a}@sandbox-1.internal`,
      `sandbox-1:${a}@10.1`,
      `sandbox-1:${a}@10.0.0.1@10.0.0.2`,
      `sandbox-1:${a}@fe80::1%eth0`,
    ])
      expect(parseRunnerTokens(entry).problems).toEqual([
        'entry 1 must be <runner id>:<sha256 hex>[@<IP address>]',
      ])
  })

  it('needs a private VM address for every token in production', () => {
    const { hashes, problems } = parseRunnerTokens(
      [
        `sandbox-1:${a}@10.20.0.11`,
        `sandbox-2:${a}@[fd00::12]`,
        `sandbox-3:${a}`,
        `sandbox-4:${a}@8.8.8.8`,
        `sandbox-5:${a}@127.0.0.1`,
        `sandbox-6:${a}@fe80::1`,
      ].join(','),
      true,
    )
    expect([...hashes.keys()]).toEqual(['sandbox-1', 'sandbox-2'])
    expect(problems).toEqual(
      [3, 4, 5, 6].map((n) => `entry ${n} needs @<private IP> in production (spec §15)`),
    )
    // Outside production a token may be unbound or bound to any address, loopback included.
    expect(parseRunnerTokens(`sandbox-3:${a},sandbox-5:${b}@127.0.0.1`).problems).toEqual([])
  })

  it('counts a hash once per runner whatever address it is bound to', () => {
    expect(
      parseRunnerTokens(`sandbox-1:${a}@10.0.0.1,sandbox-1:${a.toUpperCase()}@10.0.0.2`).problems,
    ).toEqual(['entry 2 repeats a hash of runner sandbox-1'])
  })
})
