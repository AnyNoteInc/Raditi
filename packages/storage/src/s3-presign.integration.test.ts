import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

import type { ObjectStorage } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { storageConfigFromEnv } from './config.ts'
import { createS3ObjectStorage } from './s3-object-storage.ts'

// Local S3 only (SeaweedFS from infra/dev): skipped without S3_ENDPOINT on a loopback address.
const endpoint = process.env.S3_ENDPOINT
const local =
  endpoint !== undefined &&
  URL.canParse(endpoint) &&
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname) &&
  process.env.APP_ENV !== 'production'

describe.skipIf(!local)('presigned URLs on the local S3', () => {
  // Collected even when skipped: the configuration is read only when the suite runs.
  let storage: ObjectStorage
  beforeAll(() => {
    storage = createS3ObjectStorage(storageConfigFromEnv(process.env))
  })
  const prefix = `sessions/presign-${randomUUID()}/turns/0001/`
  const keys: string[] = []
  const keyFor = (name: string) => {
    keys.push(`${prefix}${name}`)
    return `${prefix}${name}`
  }
  afterAll(async () => {
    await Promise.all(keys.map((key) => storage.delete('sessions', key)))
  })

  const send = (
    signed: { method: string; url: string; headers: Record<string, string> },
    body?: Uint8Array,
    headers = signed.headers,
  ) =>
    fetch(signed.url, {
      method: signed.method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })

  it('creates once: a second PUT of the same URL gets 412 and the object stays', async () => {
    const key = keyFor('home.tar.zst')
    const first = Buffer.from('first sealed home part')
    const put = await storage.presign({
      method: 'PUT',
      bucket: 'sessions',
      key,
      ttlMs: 60_000,
      sizeBytes: first.byteLength,
    })

    expect((await send(put, first)).status).toBe(200)
    const again = await send(put, Buffer.from('other sealed home part'))
    expect(again.status).toBe(412)

    const get = await storage.presign({ method: 'GET', bucket: 'sessions', key, ttlMs: 60_000 })
    const read = await send(get)
    expect(read.status).toBe(200)
    expect(Buffer.from(await read.arrayBuffer())).toEqual(first)
  })

  it('refuses a PUT without the signed condition or with another size', async () => {
    const key = keyFor('untracked.tar.zst')
    const body = Buffer.from('twelve bytes')
    const put = await storage.presign({
      method: 'PUT',
      bucket: 'sessions',
      key,
      ttlMs: 60_000,
      sizeBytes: body.byteLength,
    })

    expect((await send(put, body, {})).status).toBe(403)
    expect((await send(put, Buffer.from('thirteen bytes'))).status).toBe(403)
    expect(await storage.exists('sessions', key)).toBe(false)
  })

  it('refuses expired links', async () => {
    const key = keyFor('patch.diff')
    const past = createS3ObjectStorage(storageConfigFromEnv(process.env), undefined, {
      now: () => new Date(Date.now() - 10_000),
    })
    const body = Buffer.from('patch')
    const put = await past.presign({
      method: 'PUT',
      bucket: 'sessions',
      key,
      ttlMs: 1_000,
      sizeBytes: body.byteLength,
    })
    expect((await send(put, body)).status).toBe(403)
    expect(await storage.exists('sessions', key)).toBe(false)

    await storage.put('sessions', key, body)
    const get = await past.presign({ method: 'GET', bucket: 'sessions', key, ttlMs: 1_000 })
    expect((await send(get)).status).toBe(403)
  })
})

describe.skipIf(!local)('stat on the local S3', () => {
  let storage: ObjectStorage
  beforeAll(() => {
    storage = createS3ObjectStorage(storageConfigFromEnv(process.env))
  })
  const key = `sessions/stat-${randomUUID()}/object`
  afterAll(async () => {
    await storage.delete('sessions', key)
  })

  it('gives the size and the ETag of a stored object, and null for a missing key', async () => {
    const body = Buffer.from('twelve bytes')
    await storage.put('sessions', key, body, { contentType: 'text/plain' })

    expect(await storage.stat('sessions', key)).toMatchObject({
      sizeBytes: body.byteLength,
      contentType: 'text/plain',
      etag: expect.any(String),
    })
    expect(await storage.stat('sessions', `${key}-absent`)).toBeNull()
  })

  it('does not take a missing bucket for a missing key', async () => {
    const config = storageConfigFromEnv(process.env)
    const missing = createS3ObjectStorage({
      ...config,
      buckets: { ...config.buckets, sessions: `raditi-missing-${randomUUID()}` },
    })

    await expect(missing.stat('sessions', key)).rejects.toBeDefined()
  })
})
