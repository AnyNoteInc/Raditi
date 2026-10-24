import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3'
import { isDomainError } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import type { StorageConfig } from './config.ts'
import { createS3ObjectStorage } from './s3-object-storage.ts'

const config: StorageConfig = {
  endpoint: 'http://s3.test',
  region: 'ru-central1',
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
  forcePathStyle: true,
  buckets: {
    inbox: 'raditi-inbox',
    sessions: 'raditi-sessions',
    logs: 'raditi-logs',
    artifacts: 'raditi-artifacts',
    backups: 'raditi-backups',
    platform: 'raditi-platform',
  },
}

interface RecordedRequest {
  method: string
  path: string
  query: Record<string, unknown>
  headers: Record<string, string>
  body: Buffer
}

interface FakeReply {
  status: number
  headers?: Record<string, string>
  body?: string
  /** Never answers; honours the SDK abort signal. */
  hang?: boolean
}

interface HttpRequestLike {
  method: string
  path: string
  query?: Record<string, unknown>
  headers: Record<string, string>
  body?: unknown
}

async function readBody(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0)
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof Uint8Array) return Buffer.from(body)
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** A real S3Client whose HTTP layer is a stub: the SDK still builds and parses messages. */
function fakeS3(reply: (req: RecordedRequest) => FakeReply) {
  const requests: RecordedRequest[] = []
  const requestHandler = {
    async handle(request: HttpRequestLike, options?: { abortSignal?: AbortSignal }) {
      const recorded: RecordedRequest = {
        method: request.method,
        path: decodeURIComponent(request.path).replace(/\/$/, ''),
        query: request.query ?? {},
        headers: request.headers,
        body: await readBody(request.body),
      }
      requests.push(recorded)
      const r = reply(recorded)
      if (r.hang) {
        await new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
      }
      return {
        response: {
          statusCode: r.status,
          headers: r.headers ?? {},
          body: Readable.from([Buffer.from(r.body ?? '')]),
        },
      }
    },
  }
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: requestHandler as unknown as S3ClientConfig['requestHandler'],
  })
  return { client, requests }
}

const xmlError = (code: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`

async function collect(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

describe('createS3ObjectStorage', () => {
  it('claims a small object atomically without a preceding HEAD', async () => {
    const { client, requests } = fakeS3(() => ({ status: 200, headers: { etag: '"claim"' } }))
    const storage = createS3ObjectStorage(config, client)
    expect(
      await storage.putIfAbsent(
        'sessions',
        'sessions/s1/turns/0001/reservation.json',
        Buffer.from('{}'),
        {
          contentType: 'application/json',
          sizeBytes: 2,
        },
      ),
    ).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: 'PUT', body: Buffer.from('{}') })
    expect(requests[0]?.headers).toMatchObject({
      'if-none-match': '*',
      'content-type': 'application/json',
      'content-length': '2',
    })
  })

  it.each([
    [412, 'PreconditionFailed'],
    [409, 'ConditionalRequestConflict'],
  ])('returns false for the conditional-write conflict %i/%s', async (status, code) => {
    const { client, requests } = fakeS3(() => ({ status, body: xmlError(code) }))
    const storage = createS3ObjectStorage(config, client)
    await expect(storage.putIfAbsent('sessions', 'claim', Buffer.from('{}'))).resolves.toBe(false)
    expect(requests).toHaveLength(1)
  })

  it.each([
    [403, 'AccessDenied'],
    [409, 'OperationAborted'],
    [412, 'AccessDenied'],
    [500, 'PreconditionFailed'],
  ])('does not mistake %i/%s for an existing claim', async (status, code) => {
    const { client } = fakeS3(() => ({ status, body: xmlError(code) }))
    const storage = createS3ObjectStorage(config, client)
    await expect(storage.putIfAbsent('sessions', 'claim', Buffer.from('{}'))).rejects.toMatchObject(
      { name: code },
    )
  })

  it('bounds a claim to 64 KiB and checks its supplied length before any request', async () => {
    const { client, requests } = fakeS3(() => ({ status: 200 }))
    const storage = createS3ObjectStorage(config, client)
    await expect(storage.putIfAbsent('sessions', 'claim', Buffer.alloc(65_537))).rejects.toSatisfy(
      isDomainError,
    )
    await expect(
      storage.putIfAbsent('sessions', 'claim', Buffer.from('{}'), { sizeBytes: 1 }),
    ).rejects.toSatisfy(isDomainError)
    expect(requests).toHaveLength(0)
    await expect(storage.putIfAbsent('sessions', 'claim', Buffer.alloc(65_536))).resolves.toBe(true)
  })

  it('puts a byte body into the bucket mapped from its kind', async () => {
    const { client, requests } = fakeS3(() => ({ status: 200, headers: { etag: '"e1"' } }))
    const storage = createS3ObjectStorage(config, client)

    await storage.put('artifacts', 'tasks/t1/diff.patch', Buffer.from('hello'), {
      contentType: 'text/x-diff',
    })

    expect(requests).toHaveLength(1)
    const [put] = requests
    expect(put?.method).toBe('PUT')
    expect(put?.path).toBe('/raditi-artifacts/tasks/t1/diff.patch')
    expect(put?.headers['content-type']).toBe('text/x-diff')
    expect(put?.headers['content-length']).toBe('5')
    expect(put?.body.toString()).toBe('hello')
  })

  it('rejects a sizeBytes that contradicts the byte body', async () => {
    const { client, requests } = fakeS3(() => ({ status: 200 }))
    const storage = createS3ObjectStorage(config, client)

    await expect(
      storage.put('inbox', 'inbox/w/t/f', Buffer.from('hello'), { sizeBytes: 4 }),
    ).rejects.toSatisfy(isDomainError)
    expect(requests).toHaveLength(0)
  })

  it('uploads a small async iterable with a single PUT', async () => {
    const { client, requests } = fakeS3(() => ({ status: 200, headers: { etag: '"e1"' } }))
    const storage = createS3ObjectStorage(config, client)

    async function* chunks() {
      yield new TextEncoder().encode('line 1\n')
      yield new TextEncoder().encode('line 2\n')
    }
    await storage.put('logs', 'tasks/t1/events/1.jsonl.zst', chunks())

    expect(requests.map((r) => r.method)).toEqual(['PUT'])
    expect(requests[0]?.path).toBe('/raditi-logs/tasks/t1/events/1.jsonl.zst')
    expect(requests[0]?.body.toString()).toBe('line 1\nline 2\n')
  })

  it.each([
    ['shorter', 10],
    ['longer', 4],
  ])('refuses a stream %s than sizeBytes without writing the object', async (_label, size) => {
    const { client, requests } = fakeS3(() => ({ status: 200, headers: { etag: '"e1"' } }))
    const storage = createS3ObjectStorage(config, client)

    async function* sixBytes() {
      yield new TextEncoder().encode('abc')
      yield new TextEncoder().encode('def')
    }
    await expect(
      storage.put('backups', 'sites/s1/d1/db.sql.zst', sixBytes(), { sizeBytes: size }),
    ).rejects.toSatisfy(isDomainError)
    expect(requests).toHaveLength(0)
  })

  it('aborts a multipart upload whose stream turns out shorter than sizeBytes', async () => {
    const { client, requests } = fakeS3((req) => {
      if (req.method === 'POST' && 'uploads' in req.query) {
        return {
          status: 200,
          body: '<InitiateMultipartUploadResult><UploadId>up-2</UploadId></InitiateMultipartUploadResult>',
        }
      }
      if (req.method === 'PUT') return { status: 200, headers: { etag: '"p"' } }
      return { status: 204 }
    })
    const storage = createS3ObjectStorage(config, client)

    const part = Buffer.alloc(1024 * 1024, 1)
    async function* sixMegabytes() {
      for (let i = 0; i < 6; i++) yield part
    }
    await expect(
      storage.put('sessions', 'sessions/s1/turns/0002/home.tar.zst', sixMegabytes(), {
        sizeBytes: 7 * 1024 * 1024,
      }),
    ).rejects.toSatisfy(isDomainError)

    const last = requests.at(-1)
    expect(last?.method).toBe('DELETE')
    expect(last?.query.uploadId).toBe('up-2')
    expect(requests.some((r) => r.method === 'POST' && 'uploadId' in r.query)).toBe(false)
  })

  it('accepts a stream of exactly sizeBytes', async () => {
    const { client, requests } = fakeS3(() => ({ status: 200, headers: { etag: '"e1"' } }))
    const storage = createS3ObjectStorage(config, client)

    await storage.put('backups', 'sites/s1/d1/db.sql.zst', Readable.from([Buffer.from('abcdef')]), {
      sizeBytes: 6,
    })

    expect(requests.map((r) => r.body.toString())).toEqual(['abcdef'])
  })

  it('switches to multipart upload for streams above one part', async () => {
    const { client, requests } = fakeS3((req) => {
      if (req.method === 'POST' && 'uploads' in req.query) {
        return {
          status: 200,
          body: '<InitiateMultipartUploadResult><Bucket>raditi-sessions</Bucket><Key>k</Key><UploadId>up-1</UploadId></InitiateMultipartUploadResult>',
        }
      }
      if (req.method === 'PUT') {
        return { status: 200, headers: { etag: `"part-${String(req.query.partNumber)}"` } }
      }
      return {
        status: 200,
        body: '<CompleteMultipartUploadResult><Bucket>raditi-sessions</Bucket><Key>k</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>',
      }
    })
    const storage = createS3ObjectStorage(config, client)

    const part = Buffer.alloc(1024 * 1024, 1)
    async function* sixMegabytes() {
      for (let i = 0; i < 6; i++) yield part
    }
    await storage.put('sessions', 'sessions/s1/turns/0001/home.tar.zst', sixMegabytes(), {
      sizeBytes: 6 * 1024 * 1024,
    })

    const [create, ...rest] = requests
    const complete = rest.pop()
    expect(create?.method).toBe('POST')
    expect(create?.query).toHaveProperty('uploads')
    expect(rest.map((r) => [r.method, r.query.partNumber, r.query.uploadId])).toEqual([
      ['PUT', '1', 'up-1'],
      ['PUT', '2', 'up-1'],
    ])
    expect(complete?.method).toBe('POST')
    expect(complete?.query.uploadId).toBe('up-1')
    expect(complete?.body.toString()).toContain('<PartNumber>2</PartNumber>')
  })

  it('streams an existing object back', async () => {
    const { client, requests } = fakeS3(() => ({ status: 200, body: 'snapshot bytes' }))
    const storage = createS3ObjectStorage(config, client)

    const body = await storage.get('artifacts', 'snapshots/site-1/a.json')

    expect(body).not.toBeNull()
    expect(await collect(body!)).toBe('snapshot bytes')
    expect(requests[0]?.method).toBe('GET')
    expect(requests[0]?.path).toBe('/raditi-artifacts/snapshots/site-1/a.json')
  })

  it('returns null from get for NoSuchKey', async () => {
    const { client } = fakeS3(() => ({ status: 404, body: xmlError('NoSuchKey') }))
    const storage = createS3ObjectStorage(config, client)

    expect(await storage.get('inbox', 'inbox/w/t/missing')).toBeNull()
  })

  it('does not hide a missing bucket behind null', async () => {
    const { client } = fakeS3(() => ({ status: 404, body: xmlError('NoSuchBucket') }))
    const storage = createS3ObjectStorage(config, client)

    await expect(storage.get('inbox', 'inbox/w/t/f')).rejects.toMatchObject({
      name: 'NoSuchBucket',
    })
  })

  it('propagates access errors from get', async () => {
    const { client } = fakeS3(() => ({ status: 403, body: xmlError('AccessDenied') }))
    const storage = createS3ObjectStorage(config, client)

    await expect(storage.get('platform', 'pg/dump')).rejects.toMatchObject({
      name: 'AccessDenied',
    })
  })

  it('answers exists with HEAD and maps 404 to false', async () => {
    const { client, requests } = fakeS3((req) =>
      req.path.endsWith('/present') ? { status: 200 } : { status: 404 },
    )
    const storage = createS3ObjectStorage(config, client)

    expect(await storage.exists('backups', 'sites/s1/d1/present')).toBe(true)
    expect(await storage.exists('backups', 'sites/s1/d1/absent')).toBe(false)
    expect(requests.map((r) => r.method)).toEqual(['HEAD', 'HEAD'])
  })

  it('throws from exists on errors other than not found', async () => {
    const { client } = fakeS3(() => ({ status: 403 }))
    const storage = createS3ObjectStorage(config, client)

    await expect(storage.exists('backups', 'sites/s1/d1/x')).rejects.toBeDefined()
  })

  it('answers stat with HEAD: the size, the type and the ETag', async () => {
    const { client, requests } = fakeS3(() => ({
      status: 200,
      headers: { 'content-length': '1234', 'content-type': 'image/png', etag: '"9b2cf5"' },
    }))
    const storage = createS3ObjectStorage(config, client)

    expect(await storage.stat('inbox', 'inbox/w/a')).toEqual({
      sizeBytes: 1234,
      contentType: 'image/png',
      etag: '"9b2cf5"',
    })
    expect(requests.map((r) => [r.method, r.path])).toEqual([['HEAD', '/raditi-inbox/inbox/w/a']])
  })

  it('leaves out of stat what the store does not give, and keeps an empty object', async () => {
    const { client } = fakeS3(() => ({ status: 200, headers: { 'content-length': '0' } }))
    const storage = createS3ObjectStorage(config, client)

    expect(await storage.stat('inbox', 'inbox/w/empty')).toEqual({ sizeBytes: 0 })
  })

  it('answers stat null for a missing key once the bucket is known to exist', async () => {
    const { client, requests } = fakeS3((req) =>
      req.path === '/raditi-inbox' ? { status: 200 } : { status: 404 },
    )
    const storage = createS3ObjectStorage(config, client)

    expect(await storage.stat('inbox', 'inbox/w/absent')).toBeNull()
    expect(requests.map((r) => [r.method, r.path])).toEqual([
      ['HEAD', '/raditi-inbox/inbox/w/absent'],
      ['HEAD', '/raditi-inbox'],
    ])
  })

  it('does not hide a missing bucket behind a null stat', async () => {
    const { client } = fakeS3(() => ({ status: 404 }))
    const storage = createS3ObjectStorage(config, client)

    await expect(storage.stat('inbox', 'inbox/w/a')).rejects.toBeDefined()
  })

  it('throws from stat on errors other than not found, without asking the bucket', async () => {
    const { client, requests } = fakeS3(() => ({ status: 403 }))
    const storage = createS3ObjectStorage(config, client)

    await expect(storage.stat('inbox', 'inbox/w/a')).rejects.toBeDefined()
    expect(requests).toHaveLength(1)
  })

  it('deletes with DELETE', async () => {
    const { client, requests } = fakeS3(() => ({ status: 204 }))
    const storage = createS3ObjectStorage(config, client)

    await storage.delete('inbox', 'inbox/w/t/f')

    expect(requests[0]?.method).toBe('DELETE')
    expect(requests[0]?.path).toBe('/raditi-inbox/inbox/w/t/f')
  })

  it.each([
    '',
    '/abs/key',
    'a/../raditi-platform/pg',
    './x',
    'a/./b',
    'k'.repeat(1025),
    'a//b',
    'a/b/',
    '/',
    'a\u0000b',
    'a\nb',
    'a\rb',
    'a\tb',
    'a\u001fb',
    'a\u007fb',
  ])('refuses the unsafe key %j before any request', async (key) => {
    const { client, requests } = fakeS3(() => ({ status: 200 }))
    const storage = createS3ObjectStorage(config, client)

    await expect(storage.get('inbox', key)).rejects.toSatisfy(isDomainError)
    await expect(storage.exists('inbox', key)).rejects.toSatisfy(isDomainError)
    await expect(storage.stat('inbox', key)).rejects.toSatisfy(isDomainError)
    await expect(storage.delete('inbox', key)).rejects.toSatisfy(isDomainError)
    await expect(storage.put('inbox', key, Buffer.from('x'))).rejects.toSatisfy(isDomainError)
    await expect(storage.putIfAbsent('inbox', key, Buffer.from('x'))).rejects.toSatisfy(
      isDomainError,
    )
    expect(requests).toHaveLength(0)
  })

  it.each(['inbox/w/t/отчёт за май.v2.pdf', 'sites/s1/..hidden', 'a/b.c/d'])(
    'accepts the ordinary key %j',
    async (key) => {
      const { client, requests } = fakeS3(() => ({ status: 200 }))
      const storage = createS3ObjectStorage(config, client)

      await expect(storage.exists('inbox', key)).resolves.toBe(true)
      expect(requests).toHaveLength(1)
    },
  )

  it('reports every bucket in checkBuckets without throwing', async () => {
    const { client, requests } = fakeS3((req) => {
      if (req.path === '/raditi-logs') return { status: 404 }
      if (req.path === '/raditi-platform') return { status: 403 }
      return { status: 200 }
    })
    const storage = createS3ObjectStorage(config, client)

    expect(await storage.checkBuckets()).toEqual({
      inbox: true,
      sessions: true,
      logs: false,
      artifacts: true,
      backups: true,
      platform: false,
    })
    expect(requests.every((r) => r.method === 'HEAD')).toBe(true)
    expect(requests).toHaveLength(6)
  })

  it('checks only the given buckets and reports only them', async () => {
    const { client, requests } = fakeS3((req) =>
      req.path === '/raditi-logs' ? { status: 403 } : { status: 200 },
    )
    const storage = createS3ObjectStorage(config, client)

    expect(await storage.checkBuckets(['inbox', 'logs'])).toEqual({ inbox: true, logs: false })
    expect(requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'HEAD /raditi-inbox',
      'HEAD /raditi-logs',
    ])
  })

  it('sends no request for an empty list of buckets', async () => {
    const { client, requests } = fakeS3(() => ({ status: 200 }))
    const storage = createS3ObjectStorage(config, client)

    expect(await storage.checkBuckets([])).toEqual({})
    expect(requests).toHaveLength(0)
  })

  it('marks buckets that do not answer in time as unreachable', async () => {
    const { client } = fakeS3((req) =>
      req.path === '/raditi-sessions' ? { status: 200, hang: true } : { status: 200 },
    )
    const storage = createS3ObjectStorage(config, client, { healthTimeoutMs: 50 })

    const result = await storage.checkBuckets()

    expect(result.sessions).toBe(false)
    expect(result.inbox).toBe(true)
  })

  describe('presign', () => {
    const now = () => new Date('2026-09-27T10:00:00.750Z')
    const key = 'sessions/s1/turns/0002/home.tar.zst'

    it('signs a GET for the sessions bucket without sending anything', async () => {
      const { client, requests } = fakeS3(() => ({ status: 200 }))
      const storage = createS3ObjectStorage(config, client, { now })

      const signed = await storage.presign({
        method: 'GET',
        bucket: 'sessions',
        key,
        ttlMs: 300_000,
      })

      const url = new URL(signed.url)
      expect(`${url.origin}${url.pathname}`).toBe(`http://s3.test/raditi-sessions/${key}`)
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
      expect(url.searchParams.get('X-Amz-Date')).toBe('20260927T100000Z')
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
      expect(signed).toMatchObject({ method: 'GET', headers: {} })
      expect(signed.expiresAt.toISOString()).toBe('2026-09-27T10:05:00.000Z')
      expect(requests).toHaveLength(0)
    })

    it('signs a create-only PUT of an exact size', async () => {
      const { client, requests } = fakeS3(() => ({ status: 200 }))
      const storage = createS3ObjectStorage(config, client, { now })

      const signed = await storage.presign({
        method: 'PUT',
        bucket: 'sessions',
        key,
        ttlMs: 1_999,
        sizeBytes: 1234,
      })

      const url = new URL(signed.url)
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host;if-none-match')
      expect(url.searchParams.get('X-Amz-Expires')).toBe('1')
      expect(url.searchParams.has('x-id')).toBe(true)
      expect(signed).toMatchObject({ method: 'PUT', headers: { 'if-none-match': '*' } })
      expect(signed.expiresAt.toISOString()).toBe('2026-09-27T10:00:01.000Z')
      expect(signed.url).not.toContain(config.secretAccessKey)
      expect(requests).toHaveLength(0)
    })

    it('signs for the S3 address a runner sees', async () => {
      const { client } = fakeS3(() => ({ status: 200 }))
      const storage = createS3ObjectStorage(
        { ...config, presignEndpoint: 'https://s3.runner.test:9443' },
        client,
      )

      const signed = await storage.presign({
        method: 'GET',
        bucket: 'sessions',
        key,
        ttlMs: 60_000,
      })

      expect(new URL(signed.url).host).toBe('s3.runner.test:9443')
    })

    it.each([
      ['another bucket', { method: 'GET', bucket: 'platform', key, ttlMs: 60_000 }],
      ['an unsafe key', { method: 'GET', bucket: 'sessions', key: 'a/../b', ttlMs: 60_000 }],
      ['less than a second', { method: 'GET', bucket: 'sessions', key, ttlMs: 999 }],
      ['more than five minutes', { method: 'GET', bucket: 'sessions', key, ttlMs: 300_001 }],
      ['a fractional lifetime', { method: 'GET', bucket: 'sessions', key, ttlMs: 1000.5 }],
      ['a negative size', { method: 'PUT', bucket: 'sessions', key, ttlMs: 60_000, sizeBytes: -1 }],
      ['no size', { method: 'PUT', bucket: 'sessions', key, ttlMs: 60_000 }],
      ['another method', { method: 'DELETE', bucket: 'sessions', key, ttlMs: 60_000 }],
    ])('refuses %s', async (_label, request) => {
      const { client, requests } = fakeS3(() => ({ status: 200 }))
      const storage = createS3ObjectStorage(config, client)

      await expect(
        storage.presign(request as Parameters<typeof storage.presign>[0]),
      ).rejects.toSatisfy(isDomainError)
      expect(requests).toHaveLength(0)
    })
  })
})
