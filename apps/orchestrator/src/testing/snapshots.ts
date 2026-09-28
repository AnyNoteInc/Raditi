// In-memory S3 and Transit for snapshot tests: presigned URLs resolve to the same objects, as a
// sandbox host would reach them. Only for *.test.ts files (excluded from the build).
import { Buffer } from 'node:buffer'
import { zstdCompressSync } from 'node:zlib'

import {
  badRequest,
  conflict,
  notFound,
  type ObjectStorage,
  type PresignedRequest,
  type SecretStore,
} from '@repo/domain'
import { pack } from 'tar-stream'
import { vi } from 'vitest'

import type { PresignedTransfer } from '../sessions/presigned-transfer.ts'

const ORIGIN = 'https://s3.invalid/raditi-sessions/'

export function memoryStorage() {
  const objects = new Map<string, Uint8Array>()
  const keyOf = (request: PresignedRequest) => {
    if (!request.url.startsWith(ORIGIN)) throw badRequest('Foreign presigned URL')
    return new URL(request.url).pathname.slice(new URL(ORIGIN).pathname.length)
  }
  const storage = {
    putIfAbsent: vi.fn(async (_bucket, key, body) => {
      if (objects.has(key)) return false
      objects.set(key, Buffer.from(body))
      return true
    }),
    put: vi.fn(async (_bucket, key, body) => {
      const chunks: Uint8Array[] = []
      if (body instanceof Uint8Array) chunks.push(body)
      else for await (const chunk of body) chunks.push(chunk)
      objects.set(key, Buffer.concat(chunks))
    }),
    get: vi.fn(async (_bucket, key) => {
      const bytes = objects.get(key)
      if (!bytes) return null
      return (async function* () {
        yield Buffer.from(bytes)
      })()
    }),
    exists: vi.fn(async (_bucket, key) => objects.has(key)),
    delete: vi.fn(async (_bucket, key) => {
      objects.delete(key)
    }),
    checkBuckets: vi.fn(async () => ({ sessions: true })),
    presign: vi.fn(async (request) => ({
      method: request.method,
      url: `${ORIGIN}${request.key}?X-Amz-Signature=synthetic`,
      headers: (request.method === 'PUT' ? { 'if-none-match': '*' } : {}) as Record<string, string>,
      expiresAt: new Date(Date.now() + request.ttlMs),
    })),
  } satisfies ObjectStorage
  /** What a sandbox host does with the URLs: a create-only PUT answers 412 as a CONFLICT. */
  const transfer: PresignedTransfer = {
    async get(request, maxBytes) {
      const bytes = objects.get(keyOf(request))
      if (request.method !== 'GET' || !bytes) throw notFound('No such object')
      if (bytes.byteLength > maxBytes) throw badRequest('Stored object exceeds its size limit')
      return Buffer.from(bytes)
    },
    async put(request, body) {
      const key = keyOf(request)
      if (request.method !== 'PUT' || request.headers['if-none-match'] !== '*')
        throw badRequest('Expected a create-only presigned PUT')
      if (objects.has(key)) throw conflict('Stored object already exists')
      objects.set(key, Buffer.from(body))
    },
  }
  return { objects, storage, transfer }
}

/** One fixed data key; every copy handed out is kept to check that it was zeroed. */
export function memoryTransit() {
  const issued: Uint8Array[] = []
  const key = () => {
    const value = new Uint8Array(32).fill(7)
    issued.push(value)
    return value
  }
  const secrets = {
    transitDataKey: vi.fn(async () => ({ plaintext: key(), ciphertext: 'vault:v1:wrapped' })),
    transitDecryptDataKey: vi.fn(async () => key()),
  }
  return {
    secrets: secrets as unknown as SecretStore & typeof secrets,
    issued,
    allZeroed: () => issued.every((value) => value.every((byte) => byte === 0)),
  }
}

/** A snapshot archive as the sandbox's GNU tar makes it: ustar, zstd, regular files. */
export async function tarZst(files: Record<string, string>): Promise<Uint8Array> {
  const stream = pack()
  for (const [name, content] of Object.entries(files)) stream.entry({ name, mode: 0o600 }, content)
  stream.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return zstdCompressSync(Buffer.concat(chunks))
}
