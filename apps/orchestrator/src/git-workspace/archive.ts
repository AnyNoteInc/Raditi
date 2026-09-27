import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress, zstdCompressSync } from 'node:zlib'

import { badRequest, isTooLarge, publicationLimits, publicationTooLarge } from '@repo/domain'
import { extract } from 'tar-stream'

import { validateUntrackedArchive } from '../sessions/archive-validation.ts'

export const emptyUntrackedArchive = (): Uint8Array => zstdCompressSync(Buffer.alloc(1024))
export interface UntrackedFile {
  path: string
  mode: string
  bytes: Uint8Array
}

/** Reads already validated regular blobs in memory; never extracts an agent path to host FS. */
export async function untrackedFiles(input: Uint8Array): Promise<UntrackedFile[]> {
  // Parse the same owned copy that passed validation.
  const archive = await validateUntrackedArchive(input)
  const parser = extract()
  const files: UntrackedFile[] = []
  let total = 0
  parser.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = []
    stream.on('error', () => {})
    stream.on('data', (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array)) {
        parser.destroy(badRequest('Invalid publication archive'))
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
    throw isTooLarge(error) ? error : badRequest('Invalid publication archive')
  }
  return files
}
