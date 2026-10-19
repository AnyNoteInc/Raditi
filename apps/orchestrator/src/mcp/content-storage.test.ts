import { bucketKinds, type ObjectStorage } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { artifactsOnly, contentStorageConfig } from './content-storage.ts'

const config = {
  endpoint: 'http://127.0.0.1:8333',
  region: 'us-east-1',
  accessKeyId: 'test',
  secretAccessKey: 'test-secret',
  forcePathStyle: true,
  buckets: { artifacts: 'raditi-test-artifacts' },
}

function inner() {
  return {
    putIfAbsent: vi.fn(async () => true),
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    exists: vi.fn(async () => false),
    delete: vi.fn(async () => undefined),
    checkBuckets: vi.fn(async (kinds?: readonly string[]) =>
      Object.fromEntries((kinds ?? bucketKinds).map((kind) => [kind, true])),
    ),
    presign: vi.fn(),
  } satisfies ObjectStorage
}

describe('the storage of content snapshots', () => {
  it('names no bucket but the artifacts one to the S3 client', () => {
    const full = contentStorageConfig(config)
    expect(Object.keys(full.buckets).sort()).toEqual([...bucketKinds].sort())
    expect(new Set(Object.values(full.buckets))).toEqual(new Set(['raditi-test-artifacts']))
    expect(full).not.toHaveProperty('presignEndpoint')
    expect(full).toMatchObject({ endpoint: config.endpoint, forcePathStyle: true })
  })

  it('reads, writes and removes objects of the artifacts bucket', async () => {
    const storage = inner()
    const content = artifactsOnly(storage)
    const body = Buffer.from('{}')
    await content.putIfAbsent('artifacts', 'snapshots/a/b.json', body, { sizeBytes: 2 })
    await content.get('artifacts', 'snapshots/a/b.json')
    await content.delete('artifacts', 'snapshots/a/b.json')
    expect(storage.putIfAbsent).toHaveBeenCalledExactlyOnceWith(
      'artifacts',
      'snapshots/a/b.json',
      body,
      { sizeBytes: 2 },
    )
    expect(storage.get).toHaveBeenCalledExactlyOnceWith('artifacts', 'snapshots/a/b.json')
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith('artifacts', 'snapshots/a/b.json')
  })

  it('refuses every other bucket before the S3 client is asked', async () => {
    const storage = inner()
    const content = artifactsOnly(storage)
    for (const bucket of bucketKinds.filter((kind) => kind !== 'artifacts')) {
      await expect(content.putIfAbsent(bucket, 'k', Buffer.from('x'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
      await expect(content.get(bucket, 'k')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(content.delete(bucket, 'k')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(content.put(bucket, 'k', Buffer.from('x'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
    }
    expect(storage.put).not.toHaveBeenCalled()
    expect(storage.putIfAbsent).not.toHaveBeenCalled()
    expect(storage.get).not.toHaveBeenCalled()
    expect(storage.delete).not.toHaveBeenCalled()
  })

  it('checks the artifacts bucket alone for health, whatever it is asked', async () => {
    const storage = inner()
    const content = artifactsOnly(storage)
    expect(await content.checkBuckets()).toEqual({ artifacts: true })
    expect(await content.checkBuckets(['sessions', 'artifacts'])).toEqual({ artifacts: true })
    expect(storage.checkBuckets.mock.calls).toEqual([[['artifacts']], [['artifacts']]])
  })

  it('writes a screenshot of the agent browser under its own key, and nothing else', async () => {
    const storage = inner()
    const png = Buffer.from('89504e47', 'hex')
    const task = '0196abcd-0000-7000-8000-00000000000b'
    const shot = '01960000-0000-7000-8000-00000000000a'
    const key = `tasks/${task}/screenshots/${shot}.png`
    await artifactsOnly(storage).put('artifacts', key, png, {
      contentType: 'image/png',
      sizeBytes: 4,
    })
    expect(storage.put).toHaveBeenCalledExactlyOnceWith('artifacts', key, png, {
      contentType: 'image/png',
      sizeBytes: 4,
    })
    // A snapshot, a sealed value of a plan, anything else: never overwritten.
    for (const other of [
      `snapshots/${task}.json`,
      `tasks/${task}/db/${shot}/after.json`,
      `tasks/${task}/screenshots/${shot}.png.json`,
      `tasks/${task}/screenshots/../db/${shot}.png`,
      `tasks/${task.toUpperCase()}/screenshots/${shot}.png`,
    ])
      await expect(artifactsOnly(storage).put('artifacts', other, png)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
    expect(storage.put).toHaveBeenCalledOnce()
  })

  // `put` is for screenshots (plan 53, N22): each under a key of a new id, never a snapshot's.
  it('exposes nothing else of the S3 adapter: no presigned URL, no listing', () => {
    expect(Object.keys(artifactsOnly(inner())).sort()).toEqual([
      'checkBuckets',
      'delete',
      'get',
      'put',
      'putIfAbsent',
    ])
  })
})
