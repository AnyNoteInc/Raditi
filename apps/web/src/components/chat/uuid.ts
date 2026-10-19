/**
 * An id the browser invents for what it asks the server to write — a new dialog, a message, the
 * press of a command — so that a repeat of the same request is recognised and writes nothing
 * twice. RFC 9562 version 7: time-ordered, like the ids the database draws itself.
 */
export function uuidv7(
  now: number = Date.now(),
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): string {
  const bytes = random.slice(0, 16)
  if (bytes.length !== 16) throw new Error('A version 7 id needs 16 random bytes')
  // 48 bits of the Unix time in milliseconds, big-endian.
  let time = Math.max(0, Math.floor(now))
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256
    time = Math.floor(time / 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
