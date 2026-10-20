import { Buffer } from 'node:buffer'

// A tar of regular files for the docroot of a preview (docs/plan/53-chat-preview-release.md,
// Р16, Р22): POSIX ustar headers, a pax `path` record for a path that does not fit them, no
// links, owners, times or sizes in pax. What infra/preview/files.mjs reads.

const BLOCK = 512

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

function header(name: Buffer, prefix: Buffer, size: number, mode: number, type: string): Buffer {
  const block = Buffer.alloc(BLOCK)
  name.copy(block, 0)
  block.write(octal(mode, 8), 100, 'latin1')
  block.write(octal(0, 8), 108, 'latin1')
  block.write(octal(0, 8), 116, 'latin1')
  block.write(octal(size, 12), 124, 'latin1')
  block.write(octal(0, 12), 136, 'latin1')
  block.write('        ', 148, 'latin1')
  block.write(type, 156, 'latin1')
  block.write('ustar\0', 257, 'latin1')
  block.write('00', 263, 'latin1')
  prefix.copy(block, 345)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return block
}

/** `name` alone, or `prefix/name` split at a `/`, within the ustar fields; null when neither fits. */
function ustarName(path: Buffer): { name: Buffer; prefix: Buffer } | null {
  if (path.byteLength <= 100) return { name: path, prefix: Buffer.alloc(0) }
  for (let at = path.indexOf(0x2f); at !== -1; at = path.indexOf(0x2f, at + 1)) {
    if (at > 155) break
    if (path.byteLength - at - 1 <= 100 && path.byteLength - at - 1 > 0)
      return { name: path.subarray(at + 1), prefix: path.subarray(0, at) }
  }
  return null
}

/** One pax record `<length> path=<value>\n`, its length counting itself. */
function paxPath(path: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(' path='), path, Buffer.from('\n')])
  let length = body.byteLength + 1
  while (String(length).length + body.byteLength !== length) length += 1
  return Buffer.concat([Buffer.from(String(length)), body])
}

/** What the name field of an entry named by a pax record holds. */
const LONG_NAME = Buffer.from('raditi-long-name')

export const tarPadding = (size: number): Buffer => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK)

/** The end of an archive: two zero blocks. */
export const TAR_END = Buffer.alloc(2 * BLOCK)

/** The headers of one regular file of `size` bytes; its content and `tarPadding` follow. */
export function tarFileHeader(path: string, size: number, executable: boolean): Buffer {
  const bytes = Buffer.from(path, 'utf8')
  const mode = executable ? 0o755 : 0o644
  const fitted = ustarName(bytes)
  if (fitted) return header(fitted.name, fitted.prefix, size, mode, '0')
  const record = paxPath(bytes)
  return Buffer.concat([
    header(Buffer.from('PaxHeader'), Buffer.alloc(0), record.byteLength, 0o644, 'x'),
    record,
    tarPadding(record.byteLength),
    // The pax record above names the entry; its own field holds a stand-in in ASCII.
    header(LONG_NAME, Buffer.alloc(0), size, mode, '0'),
  ])
}

/** The header of a directory: what a file of the platform needs below the root. */
export function tarDirectoryHeader(path: string): Buffer {
  const bytes = Buffer.from(`${path.replace(/\/+$/, '')}/`, 'utf8')
  const fitted = ustarName(bytes)
  if (fitted) return header(fitted.name, fitted.prefix, 0, 0o755, '5')
  const record = paxPath(bytes)
  return Buffer.concat([
    header(Buffer.from('PaxHeader'), Buffer.alloc(0), record.byteLength, 0o644, 'x'),
    record,
    tarPadding(record.byteLength),
    header(LONG_NAME, Buffer.alloc(0), 0, 0o755, '5'),
  ])
}
