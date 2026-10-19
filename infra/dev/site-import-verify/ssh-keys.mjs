// SSH keys of the stand's hosting, made in Node without ssh-keygen: the two host keys of sshd, the
// key of the user `site`, and a second user key behind a passphrase. Pure apart from the random
// generation in `newEd25519Key` and `newRsaKeyWithPassphrase`; nothing here touches a file.
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'

/** An SSH wire `string`: a 32-bit big-endian length and the bytes. */
function sshString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  return Buffer.concat([length, bytes])
}

function uint32(value) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value >>> 0)
  return bytes
}

/** An SSH `mpint` of a non-negative big-endian magnitude: no leading zeros, one 0x00 for the sign. */
function mpint(magnitude) {
  let start = 0
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++
  const trimmed = magnitude.subarray(start)
  return sshString(trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed)
}

/** The public key blob of an Ed25519 key (RFC 8709). */
export function ed25519PublicBlob(publicKey) {
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32)
    throw new Error('An Ed25519 public key has 32 bytes')
  return Buffer.concat([sshString('ssh-ed25519'), sshString(publicKey)])
}

/** The public key blob of an RSA key (RFC 4253): e, then n. */
export function rsaPublicBlob({ e, n }) {
  return Buffer.concat([sshString('ssh-rsa'), mpint(e), mpint(n)])
}

/** The key type a blob names: its first string. */
export function blobType(blob) {
  const length = blob.readUInt32BE(0)
  return blob.subarray(4, 4 + length).toString('utf8')
}

/**
 * The fingerprint the product shows and stores (packages/domain hostKeySchema): the key type,
 * then `SHA256:` and the unpadded base64 of the SHA-256 of the public key blob — what
 * `ssh-keygen -l` prints after the bit count, with the type in front.
 */
export function hostKeyFingerprint(blob) {
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  return `${blobType(blob)} SHA256:${digest}`
}

/** The `authorized_keys` / `.pub` line of a blob. */
export function publicKeyLine(blob, comment = '') {
  return `${blobType(blob)} ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`
}

/**
 * An unencrypted Ed25519 private key in the OpenSSH format (PROTOCOL.key of OpenSSH): what sshd
 * reads as a host key and ssh2 reads as a user key. `checkint` repeats twice in the private
 * section; any value does when there is no cipher.
 */
export function openSshEd25519PrivateKey({ seed, publicKey, comment = '', checkint = 0 }) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error('An Ed25519 seed has 32 bytes')
  const blob = ed25519PublicBlob(publicKey)
  let section = Buffer.concat([
    uint32(checkint),
    uint32(checkint),
    sshString('ssh-ed25519'),
    sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])),
    sshString(comment),
  ])
  // Padded to the block size of the `none` cipher (8) with 1, 2, 3, …
  for (let pad = 1; section.length % 8 !== 0; pad++)
    section = Buffer.concat([section, Buffer.from([pad])])
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    sshString('none'),
    sshString('none'),
    sshString(Buffer.alloc(0)),
    uint32(1),
    sshString(blob),
    sshString(section),
  ])
  const lines = body.toString('base64').match(/.{1,70}/g)
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

/** A new Ed25519 key: the OpenSSH private key, its public line and its fingerprint. */
export function newEd25519Key(comment) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url')
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
  const blob = ed25519PublicBlob(pub)
  return {
    privateKey: openSshEd25519PrivateKey({
      seed,
      publicKey: pub,
      comment,
      checkint: randomBytes(4).readUInt32BE(0),
    }),
    publicKey: publicKeyLine(blob, comment),
    fingerprint: hostKeyFingerprint(blob),
  }
}

/**
 * A new RSA key whose PEM (PKCS#1, AES-256-CBC) opens only with `passphrase`: the user key «с
 * парольной фразой» of the wizard. The passphrase is an argument of a function, never of a process.
 */
export function newRsaKeyWithPassphrase(passphrase, comment) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase },
    publicKeyEncoding: { type: 'spki', format: 'jwk' },
  })
  const blob = rsaPublicBlob({
    e: Buffer.from(publicKey.e, 'base64url'),
    n: Buffer.from(publicKey.n, 'base64url'),
  })
  return {
    privateKey,
    passphrase,
    publicKey: publicKeyLine(blob, comment),
    fingerprint: hostKeyFingerprint(blob),
  }
}
