import ssh2 from 'ssh2'

import { sshKeyFingerprint } from '../sources/host-key.ts'

/** A disposable SSH key pair for the fakes on loopback; never a key of a real server or user. */
export interface TestSshKey {
  /** OpenSSH private key (encrypted when a passphrase was given): what `hostKeyPem` and a key login take. */
  privateKey: string
  /** One `authorized_keys` line. */
  publicKey: string
  /** "<type> SHA256:<digest>", as a check returns it and the secret pins it. */
  fingerprint: string
}

/** The fingerprint the SFTP adapter computes, from a public key line or a private key (unencrypted). */
export function sshFingerprintOf(key: string): string {
  const parsed = ssh2.utils.parseKey(key)
  if (parsed instanceof Error) throw new TypeError('not an SSH key')
  const fingerprint = sshKeyFingerprint(parsed.getPublicSSH())
  if (fingerprint === null) throw new TypeError('not an SSH key the adapter can pin')
  return fingerprint
}

/**
 * ssh2 1.17 writes an ed25519 key whose public half begins with a zero byte one byte short (about one
 * key in 256), and then cannot read it back. Such a pair is drawn again: a test key must be one that
 * both halves of the package read.
 */
const KEY_ATTEMPTS = 16

function readable(
  pair: { private: string; public: string },
  passphrase: string | undefined,
): boolean {
  return (
    !(ssh2.utils.parseKey(pair.public) instanceof Error) &&
    !(ssh2.utils.parseKey(pair.private, passphrase) instanceof Error)
  )
}

/**
 * The same encrypted OpenSSH private key with the bcrypt rounds of its KDF options rewritten: what a
 * key that asks the parser for hours of synchronous work looks like. Nothing else changes, so ssh2
 * would spend every round before its integrity check failed — the adapter must refuse it first.
 */
export function withKdfRounds(privateKey: string, rounds: number): string {
  const match =
    /-----BEGIN OPENSSH PRIVATE KEY-----\r?\n([\s\S]+?)\r?\n-----END OPENSSH PRIVATE KEY-----/.exec(
      privateKey,
    )
  if (!match?.[1]) throw new TypeError('not an OpenSSH private key')
  const data = Buffer.from(match[1], 'base64')
  // magic "openssh-key-v1\0", string cipher, string kdf, string kdfoptions = (string salt, uint32 rounds)
  let offset = 15
  const next = () => {
    const start = offset + 4
    offset = start + data.readUInt32BE(offset)
    return data.subarray(start, offset)
  }
  next()
  if (next().toString('latin1') !== 'bcrypt') throw new TypeError('not a key encrypted with bcrypt')
  const options = offset + 4
  data.writeUInt32BE(rounds >>> 0, options + 4 + data.readUInt32BE(options))
  const body = data.toString('base64').replace(/.{70}/g, '$&\n').replace(/\n$/, '')
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`
}

export function generateTestSshKey(
  options: { type?: 'ed25519' | 'ecdsa' | 'rsa'; passphrase?: string } = {},
): TestSshKey {
  const { type = 'ed25519', passphrase } = options
  // The KDF rounds are few on purpose: a test key protects nothing.
  const encryption: ssh2.utils.KeyPairOptions =
    passphrase === undefined ? {} : { passphrase, cipher: 'aes256-ctr', rounds: 2 }
  for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt += 1) {
    const pair =
      type === 'rsa'
        ? ssh2.utils.generateKeyPairSync('rsa', { bits: 2048, ...encryption })
        : type === 'ecdsa'
          ? ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256, ...encryption })
          : ssh2.utils.generateKeyPairSync('ed25519', encryption)
    if (!readable(pair, passphrase)) continue
    return {
      privateKey: pair.private,
      publicKey: pair.public,
      fingerprint: sshFingerprintOf(pair.public),
    }
  }
  throw new Error('ssh2 generated no readable key')
}
