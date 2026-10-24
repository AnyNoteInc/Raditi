import { randomBytes } from 'node:crypto'

/**
 * RFC 9562 version 7: the ids of this schema are time-ordered, as Prisma's uuid(7). For a row a
 * raw statement inserts, or whose id another column is built from.
 */
export function uuidv7(): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(Date.now(), 0, 6)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
