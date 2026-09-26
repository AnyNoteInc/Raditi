import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import {
  badRequest,
  bucketKinds,
  type BucketKind,
  type ObjectStorage,
  type PutOptions,
} from '@repo/domain'

import type { StorageConfig } from './config.ts'

export interface S3ObjectStorageOptions {
  /** Upper bound for one checkBuckets() call, retries included. */
  healthTimeoutMs?: number
}

const DEFAULT_HEALTH_TIMEOUT_MS = 3_000
const MAX_KEY_BYTES = 1024

export function createS3Client(config: StorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
    // Since SDK 3.729 checksums are computed by default and sent as aws-chunked trailers,
    // which S3-compatible stores (SeaweedFS, Russian clouds) may reject. Only when required.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

/**
 * ObjectStorage port (spec §14) over any S3-compatible store.
 * TODO(P1, M2): presigned GET/PUT URLs for the browser (15 minutes) and browser multipart
 * upload; streams already go through lib-storage multipart on the server side.
 */
export function createS3ObjectStorage(
  config: StorageConfig,
  client: S3Client = createS3Client(config),
  options: S3ObjectStorageOptions = {},
): ObjectStorage {
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const bucketOf = (kind: BucketKind): string => config.buckets[kind]

  return {
    async put(bucket, key, body, opts?: PutOptions) {
      assertKey(key)
      const sizeBytes = opts?.sizeBytes
      let payload: Uint8Array | Readable
      if (body instanceof Uint8Array) {
        if (sizeBytes !== undefined && sizeBytes !== body.byteLength) {
          throw badRequest('sizeBytes does not match the body length')
        }
        payload = body
      } else {
        // Not sent as ContentLength: a wrong header would stall the request instead of failing.
        payload = Readable.from(sizeBytes === undefined ? body : checkedLength(body, sizeBytes))
      }
      // One PutObject up to 5 MB, multipart above; a failed multipart upload is aborted.
      const upload = new Upload({
        client,
        params: {
          Bucket: bucketOf(bucket),
          Key: key,
          Body: payload,
          ContentType: opts?.contentType,
        },
      })
      await upload.done()
    },

    async get(bucket, key) {
      assertKey(key)
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucketOf(bucket), Key: key }))
        return toAsyncIterable(res.Body)
      } catch (err) {
        if (isMissingObject(err)) return null
        throw err
      }
    },

    async exists(bucket, key) {
      assertKey(key)
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucketOf(bucket), Key: key }))
        return true
      } catch (err) {
        if (isMissingObject(err)) return false
        throw err
      }
    },

    async delete(bucket, key) {
      assertKey(key)
      // S3 DeleteObject is idempotent: a missing key is not an error.
      await client.send(new DeleteObjectCommand({ Bucket: bucketOf(bucket), Key: key }))
    },

    async checkBuckets(kinds = bucketKinds) {
      const abortSignal = AbortSignal.timeout(healthTimeoutMs)
      const results = await Promise.all(
        kinds.map(async (kind) => {
          try {
            await client.send(new HeadBucketCommand({ Bucket: bucketOf(kind) }), { abortSignal })
            return [kind, true] as const
          } catch {
            return [kind, false] as const
          }
        }),
      )
      return Object.fromEntries(results) as Partial<Record<BucketKind, boolean>>
    },
  }
}

/** C0 controls and DEL: they break signatures, logs and the proxies in between. */
function hasControlCharacter(key: string): boolean {
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * Keys are built by the platform, but a `.`/`..` or empty segment (`a//b`, a leading or
 * trailing `/`) could still be normalised by a path-style endpoint or proxy into another
 * key or bucket, so such keys are refused outright, as are control characters.
 */
function assertKey(key: string): void {
  if (
    key === '' ||
    Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES ||
    hasControlCharacter(key) ||
    key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw badRequest('Invalid object key')
  }
}

function isMissingObject(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  if (e.name === 'NoSuchKey' || e.name === 'NotFound') return true
  // A missing bucket is a configuration error, not a missing object.
  return e.$metadata?.httpStatusCode === 404 && e.name !== 'NoSuchBucket'
}

/** Fails the stream (so the object is never completed) when it is not exactly `expected` bytes. */
async function* checkedLength(
  source: AsyncIterable<Uint8Array>,
  expected: number,
): AsyncIterable<Uint8Array> {
  let total = 0
  for await (const chunk of source) {
    total += chunk.byteLength
    if (total > expected) throw badRequest('The stream is longer than sizeBytes')
    yield chunk
  }
  if (total !== expected) throw badRequest('The stream is shorter than sizeBytes')
}

async function* emptyBody(): AsyncIterable<Uint8Array> {}

function toAsyncIterable(body: unknown): AsyncIterable<Uint8Array> {
  if (body === undefined || body === null) return emptyBody()
  // In Node the SDK returns an IncomingMessage: an async iterable of Buffers.
  if (typeof body === 'object' && Symbol.asyncIterator in body) {
    return body as AsyncIterable<Uint8Array>
  }
  throw new Error('[@repo/storage] unexpected S3 response body type')
}
