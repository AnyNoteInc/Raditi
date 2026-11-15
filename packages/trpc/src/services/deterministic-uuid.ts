import { createHash } from 'node:crypto'

/**
 * A UUID of version 7 derived from what it names (RFC 9562): the moment in the first 48 bits, the
 * rest from SHA-256 of `<namespace>:<salt>`. The same thing gives the same id, so a chat started
 * for it is recognised as the chat it started when it is handed again: an update of the bot of
 * Telegram (docs/plan/80-telegram.md), a run of a scheduled task (docs/plan/82-scheduled-tasks.md,
 * Зп20). A chat without a project takes only ids of this version (К14).
 */
export function deterministicUuidV7(namespace: string, salt: string, at: Date): string {
  const hash = createHash('sha256').update(`${namespace}:${salt}`).digest()
  const bytes = Buffer.alloc(16)
  bytes.writeUIntBE(Math.max(0, Math.min(at.getTime(), 2 ** 48 - 1)), 0, 6)
  hash.copy(bytes, 6, 0, 10)
  bytes[6] = 0x70 | (bytes[6]! & 0x0f)
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
