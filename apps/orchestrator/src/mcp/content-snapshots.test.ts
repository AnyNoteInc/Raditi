import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { sha256 } from '../sessions/snapshot-crypto.ts'
import { memoryStorage, memoryTransit } from '../testing/snapshots.ts'
import {
  CONTENT_SNAPSHOT_MAX_BYTES,
  ContentSnapshotStorage,
  contentSnapshotKey,
  type ContentSnapshotRef,
} from './content-snapshots.ts'

const now = new Date('2026-10-01T10:00:00Z')
function setup() {
  const memory = memoryStorage()
  const transit = memoryTransit()
  const service = new ContentSnapshotStorage(memory.storage, transit.secrets, () => now)
  const ref: ContentSnapshotRef = {
    id: randomUUID(),
    workspaceId: randomUUID(),
    siteId: randomUUID(),
    taskId: randomUUID(),
    objectRef: 'post:42',
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
  }
  return { memory, transit, service, ref }
}

describe('encrypted content snapshots', () => {
  it('restores exact Unicode state after restart, storing only ciphertext in artifacts', async () => {
    const { memory, transit, service, ref } = setup()
    const original = Buffer.from(
      JSON.stringify({ title: 'Синтетическая страница', content: 'Текст 🪴 private@example.test' }),
    )
    const receipt = await service.save(ref, original)
    expect(memory.storage.putIfAbsent).toHaveBeenCalledWith(
      'artifacts',
      contentSnapshotKey(ref),
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'application/json' }),
    )
    const stored = memory.objects.get(contentSnapshotKey(ref))!
    expect(Buffer.from(stored).toString()).not.toMatch(/Синтетическая|private@example|Текст/)
    expect(receipt).toMatchObject({ payloadSha256: sha256(stored), sizeBytes: stored.byteLength })
    const restarted = new ContentSnapshotStorage(memory.storage, transit.secrets, () => now)
    expect(Buffer.from(await restarted.load(receipt))).toEqual(original)
    expect(transit.allZeroed()).toBe(true)
    expect(memory.storage.presign).not.toHaveBeenCalled()
  })

  it('reuses an acknowledged immutable snapshot and refuses a different capture', async () => {
    const { memory, transit, service, ref } = setup()
    const first = await service.save(ref, Buffer.from('before'))
    const stored = Buffer.from(memory.objects.get(contentSnapshotKey(ref))!)
    expect(await service.save(ref, Buffer.from('before'))).toEqual(first)
    await expect(service.save(ref, Buffer.from('after'))).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(memory.objects.get(contentSnapshotKey(ref))).toEqual(stored)
    expect(transit.allZeroed()).toBe(true)
  })

  it('recovers a lost PUT acknowledgement without overwriting the first artifact', async () => {
    const { memory, transit, service, ref } = setup()
    memory.storage.putIfAbsent.mockImplementationOnce(async (_bucket, key, body) => {
      memory.objects.set(key, Buffer.from(body))
      throw new Error('private storage credential synthetic-secret')
    })
    await expect(service.save(ref, Buffer.from('before'))).rejects.toMatchObject({
      code: 'CONTENT_SNAPSHOT_UNAVAILABLE',
      message: 'Content snapshot storage is unavailable',
    })
    const stored = Buffer.from(memory.objects.get(contentSnapshotKey(ref))!)
    const recovered = await service.save(ref, Buffer.from('before'))
    expect(recovered.payloadSha256).toBe(sha256(stored))
    expect(memory.objects.get(contentSnapshotKey(ref))).toEqual(stored)
    expect(transit.allZeroed()).toBe(true)
  })

  it.each(['taskId', 'workspaceId', 'objectRef', 'expiresAt'] as const)(
    'authenticates %s before asking Transit for a key',
    async (field) => {
      const { transit, service, ref } = setup()
      const receipt = await service.save(ref, Buffer.from('before'))
      const changes = {
        taskId: randomUUID(),
        workspaceId: randomUUID(),
        objectRef: 'post:43',
        expiresAt: new Date(ref.expiresAt.getTime() + 1),
      }
      await expect(service.load({ ...receipt, [field]: changes[field] })).rejects.toMatchObject({
        code: 'CONTENT_SNAPSHOT_INVALID',
      })
      expect(transit.secrets.transitDecryptDataKey).not.toHaveBeenCalled()
    },
  )

  it('checks the SQL receipt hash and then the GCM tag, even if a corrupt receipt hash is supplied', async () => {
    const { memory, transit, service, ref } = setup()
    const receipt = await service.save(ref, Buffer.from('before'))
    const key = contentSnapshotKey(ref)
    const artifact = JSON.parse(Buffer.from(memory.objects.get(key)!).toString()) as {
      ciphertext: string
    }
    artifact.ciphertext = Buffer.from('tamper').toString('base64')
    const corrupt = Buffer.from(JSON.stringify(artifact))
    memory.objects.set(key, corrupt)
    await expect(service.load(receipt)).rejects.toMatchObject({ code: 'CONTENT_SNAPSHOT_INVALID' })
    expect(transit.secrets.transitDecryptDataKey).not.toHaveBeenCalled()
    await expect(
      service.load({ ...receipt, payloadSha256: sha256(corrupt), sizeBytes: corrupt.byteLength }),
    ).rejects.toMatchObject({ code: 'CONTENT_SNAPSHOT_INVALID' })
    expect(transit.allZeroed()).toBe(true)
  })

  it('loads a snapshot past its capture expiry: the journal decides when it is purged', async () => {
    const { memory, transit, service, ref } = setup()
    const receipt = await service.save(ref, Buffer.from('before'))
    const later = new ContentSnapshotStorage(
      memory.storage,
      transit.secrets,
      () => new Date(ref.expiresAt.getTime() + 86400_000),
    )
    expect(Buffer.from(await later.load(receipt)).toString()).toBe('before')
  })

  it('rejects expired, invalid and oversized input without any storage or Transit call', async () => {
    const { memory, transit, service, ref } = setup()
    await expect(
      service.save({ ...ref, expiresAt: now }, Buffer.from('before')),
    ).rejects.toMatchObject({ code: 'CONTENT_SNAPSHOT_EXPIRED' })
    await expect(
      service.save({ ...ref, objectRef: '\0private' }, Buffer.from('before')),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid content snapshot reference' })
    await expect(
      service.save(ref, Buffer.alloc(CONTENT_SNAPSHOT_MAX_BYTES + 1)),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_TOO_LARGE' })
    expect(memory.storage.putIfAbsent).not.toHaveBeenCalled()
    expect(transit.secrets.transitDataKey).not.toHaveBeenCalled()
  })

  it('captures an owned copy while Transit is pending and supports the maximum state size', async () => {
    const { service, ref, transit } = setup()
    const pending = Promise.withResolvers<{
      plaintext: Uint8Array<ArrayBuffer>
      ciphertext: string
    }>()
    transit.secrets.transitDataKey.mockReturnValueOnce(pending.promise)
    const source = Buffer.alloc(CONTENT_SNAPSHOT_MAX_BYTES, 9)
    const saving = service.save(ref, source)
    source.fill(0)
    pending.resolve({ plaintext: new Uint8Array(32).fill(7), ciphertext: 'vault:v1:wrapped' })
    const receipt = await saving
    expect(Buffer.from(await service.load(receipt))).toEqual(
      Buffer.alloc(CONTENT_SNAPSHOT_MAX_BYTES, 9),
    )
  })

  it('stops an oversized stream and maps a Transit outage to a fixed availability error', async () => {
    const { memory, transit, service, ref } = setup()
    const receipt = await service.save(ref, Buffer.from('before'))
    let closed = false
    memory.storage.get.mockImplementationOnce(async () =>
      (async function* () {
        try {
          yield Buffer.alloc(65537)
        } finally {
          closed = true
        }
      })(),
    )
    await expect(service.load(receipt)).rejects.toMatchObject({ code: 'CONTENT_SNAPSHOT_INVALID' })
    expect(closed).toBe(true)
    transit.secrets.transitDecryptDataKey.mockRejectedValueOnce(
      new Error('synthetic private token'),
    )
    await expect(service.load(receipt)).rejects.toMatchObject({
      code: 'CONTENT_SNAPSHOT_UNAVAILABLE',
      message: 'Content snapshot storage is unavailable',
    })
  })
})
