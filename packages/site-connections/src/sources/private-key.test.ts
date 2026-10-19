import { generateKeyPairSync } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { generateTestSshKey, withKdfRounds } from '../testing/index.ts'
import { keyDerivationAllowed, MAX_KEY_KDF_ROUNDS } from './private-key.ts'

const locked = generateTestSshKey({ passphrase: 'correct horse' })

describe('keyDerivationAllowed', () => {
  it('lets through a key without a KDF, a key of few rounds and every other format', () => {
    expect(keyDerivationAllowed(generateTestSshKey().privateKey)).toBe(true)
    expect(keyDerivationAllowed(locked.privateKey)).toBe(true)
    expect(keyDerivationAllowed(withKdfRounds(locked.privateKey, MAX_KEY_KDF_ROUNDS))).toBe(true)
    const { privateKey: pem } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'sec1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    expect(pem).toMatch(/^-----BEGIN EC PRIVATE KEY-----/)
    expect(keyDerivationAllowed(pem)).toBe(true)
    expect(keyDerivationAllowed('not a key')).toBe(true)
  })

  it('refuses a key that asks for more rounds, before any of them is computed', () => {
    for (const rounds of [MAX_KEY_KDF_ROUNDS + 1, 1 << 20, 0xffffffff]) {
      const key = withKdfRounds(locked.privateKey, rounds)
      const started = performance.now()
      expect(keyDerivationAllowed(key)).toBe(false)
      expect(performance.now() - started).toBeLessThan(50)
    }
    // The text around the body as a user may paste it: ssh2 trims it, so this does too.
    expect(keyDerivationAllowed(`\n  ${withKdfRounds(locked.privateKey, 1 << 20)}  \n`)).toBe(false)
  })

  it('refuses an OpenSSH key whose fields cannot be read', () => {
    const body = (text: string) =>
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${text}\n-----END OPENSSH PRIVATE KEY-----`
    const field = (value: string) => {
      const bytes = Buffer.from(value, 'latin1')
      const length = Buffer.alloc(4)
      length.writeUInt32BE(bytes.length)
      return Buffer.concat([length, bytes])
    }
    const magic = Buffer.from('openssh-key-v1\0', 'latin1')
    const encode = (...parts: Buffer[]) => body(Buffer.concat(parts).toString('base64'))
    expect(keyDerivationAllowed(body(Buffer.from('openssh-key-v2\0').toString('base64')))).toBe(
      false,
    )
    // The KDF options cut after the salt: no rounds to read.
    expect(
      keyDerivationAllowed(
        encode(
          magic,
          field('aes256-ctr'),
          field('bcrypt'),
          field(field('0123456789abcdef').toString('latin1')),
        ),
      ),
    ).toBe(false)
    // A length that points past the end.
    expect(
      keyDerivationAllowed(encode(magic, field('aes256-ctr'), Buffer.from([0, 0, 0xff, 0xff]))),
    ).toBe(false)
    // A KDF ssh2 does not run.
    expect(
      keyDerivationAllowed(encode(magic, field('aes256-ctr'), field('scrypt'), field('x'))),
    ).toBe(false)
  })
})
