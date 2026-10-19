// ssh2 1.17 decrypts an OpenSSH private key with bcrypt_pbkdf in plain JavaScript, synchronously,
// for as many rounds as the key itself names (a uint32 of its KDF options): about 13 ms a round, so
// one key that asks for 2^20 rounds holds the event loop of the whole process for hours, and no
// signal can preempt it. The rounds are read here first, the way ssh2 reads them, and a key that
// asks for more is refused before ssh2 sees it. Every other format ssh2 reads (PEM with DEK-Info,
// PuTTY v2) derives its key with one MD5 or SHA-1 pass.

/** ssh-keygen writes 16 by default (`-a`); 64 costs under a second. */
export const MAX_KEY_KDF_ROUNDS = 64

/** ssh2's own pattern, matched on the same trimmed text: a key it would parse is a key read here. */
const OPENSSH_KEY =
  /^-----BEGIN OPENSSH PRIVATE KEY-----(?:\r\n|\n)([\s\S]+)(?:\r\n|\n)-----END OPENSSH PRIVATE KEY-----$/
const MAGIC = 'openssh-key-v1\0'

/** One SSH `string` (uint32 length, then the bytes) at `offset`; null past the end. */
function readString(data: Buffer, offset: number): { value: Buffer; end: number } | null {
  if (offset < 0 || offset + 4 > data.length) return null
  const length = data.readUInt32BE(offset)
  const end = offset + 4 + length
  if (end > data.length) return null
  return { value: data.subarray(offset + 4, end), end }
}

/**
 * Whether ssh2 may be given this private key: true for any other format, and for an OpenSSH key
 * without a KDF or with a bcrypt KDF of at most MAX_KEY_KDF_ROUNDS rounds. An OpenSSH key whose
 * fields cannot be read, or that names another KDF, is refused: ssh2 would refuse it as well.
 */
export function keyDerivationAllowed(privateKey: string): boolean {
  const match = OPENSSH_KEY.exec(privateKey.trim())
  if (match === null) return true
  const data = Buffer.from(match[1] ?? '', 'base64')
  if (data.length < MAGIC.length || data.toString('latin1', 0, MAGIC.length) !== MAGIC) return false
  const cipher = readString(data, MAGIC.length)
  if (!cipher) return false
  const kdf = readString(data, cipher.end)
  if (!kdf) return false
  const options = readString(data, kdf.end)
  if (!options) return false
  const kdfName = kdf.value.toString('latin1')
  if (kdfName === 'none') return true
  if (kdfName !== 'bcrypt') return false
  // string salt, uint32 rounds
  const salt = readString(options.value, 0)
  if (!salt || salt.end + 4 > options.value.length) return false
  return options.value.readUInt32BE(salt.end) <= MAX_KEY_KDF_ROUNDS
}
