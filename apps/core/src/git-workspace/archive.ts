import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress, zstdCompressSync } from 'node:zlib'

import {
  isTooLarge,
  publicationLimits,
  publicationTooLarge,
  turnOutputRejected,
} from '@repo/domain'
import { extract } from 'tar-stream'

import { validateUntrackedArchive } from '@repo/snapshots'

export const emptyUntrackedArchive = (): Uint8Array => zstdCompressSync(Buffer.alloc(1024))
export interface UntrackedFile {
  path: string
  mode: string
  bytes: Uint8Array
}
/** The agent's new files: a malformed archive is its output, not the client's input. */
const invalid = () => turnOutputRejected('Invalid publication archive')

/** Reads already validated regular blobs in memory; never extracts an agent path to host FS. */
export async function untrackedFiles(input: Uint8Array): Promise<UntrackedFile[]> {
  let archive: Uint8Array
  try {
    // Parse the same owned copy that passed validation.
    archive = await validateUntrackedArchive(input)
  } catch (error) {
    throw isTooLarge(error) ? error : invalid()
  }
  const parser = extract()
  const files: UntrackedFile[] = []
  let total = 0
  parser.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = []
    stream.on('error', () => {})
    stream.on('data', (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array)) {
        parser.destroy(invalid())
        return
      }
      total += chunk.byteLength
      if (total > publicationLimits.treeBytes)
        parser.destroy(publicationTooLarge('Publication tree is too large'))
      else chunks.push(Buffer.from(chunk))
    })
    stream.on('end', () => {
      if (header.type === 'file')
        files.push({
          path: header.name,
          mode: (header.mode ?? 0) & 0o111 ? '100755' : '100644',
          bytes: Buffer.concat(chunks),
        })
      next()
    })
    stream.resume()
  })
  try {
    await pipeline(Readable.from([archive]), createZstdDecompress(), parser)
  } catch (error) {
    throw isTooLarge(error) ? error : invalid()
  }
  return files
}
