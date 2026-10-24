import { zstdCompressSync } from 'node:zlib'

import {
  DomainError,
  snapshotLimits,
  type ObjectStorage,
  type PresignedRequest,
  type SecretStore,
  type SnapshotMetadata,
  type SnapshotReference,
  type TurnSealInput,
  turnSnapshotPrefix,
} from '@repo/domain'
import { pack } from 'tar-stream'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { sealSnapshotPart } from '@repo/snapshots'

import { sampleDriverId } from '../testing/ids.ts'
import { SnapshotService, type SealedElsewhere } from './snapshot.service.ts'

const metadata: SnapshotMetadata & { git: NonNullable<SnapshotMetadata['git']> } = {
  workspaceId: 'ws1',
  sessionId: 's1',
  turn: 1,
  image: `registry/raditi@sha256:${'a'.repeat(64)}`,
  driver: { id: sampleDriverId, version: '1.18.34', nativeSessionId: 'ses_0001' },
  git: { provider: 'gitea', branch: 'task/t1', baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) },
  home: {
    root: `/agent-home/${sampleDriverId}`,
    include: ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'],
    exclude: [],
  },
}
const reference: SnapshotReference = {
  workspaceId: metadata.workspaceId,
  sessionId: metadata.sessionId,
  turn: metadata.turn,
  image: metadata.image,
  driver: { id: sampleDriverId, version: '1.18.34' },
  home: metadata.home,
}
const prefix = turnSnapshotPrefix('s1', 1)
const manifestKey = `${prefix}manifest.json`

async function archive(name: string, content: string): Promise<Uint8Array> {
  const stream = pack()
  stream.entry({ name, mode: 0o600 }, content)
  stream.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return zstdCompressSync(Buffer.concat(chunks))
}
async function parts() {
  return {
    home: await archive(metadata.home.include[0]!, 'native-session-data'),
    untracked: await archive('new.txt', 'new file'),
    patch: Buffer.from('binary patch\0\xff'),
  }
}

function fixture() {
  const objects = new Map<string, Uint8Array>()
  const writes: string[] = []
  const storage: ObjectStorage = {
    putIfAbsent: vi.fn(async (_bucket, key, body) => {
      if (objects.has(key)) return false
      objects.set(key, Uint8Array.from(body))
      return true
    }),
    put: vi.fn(async (_bucket, key, body) => {
      const chunks: Uint8Array[] = []
      if (body instanceof Uint8Array) chunks.push(body)
      else for await (const chunk of body) chunks.push(chunk)
      objects.set(key, Buffer.concat(chunks))
      writes.push(key)
    }),
    get: vi.fn(async (_bucket, key) => {
      const bytes = objects.get(key)
      if (!bytes) return null
      return (async function* () {
        yield Uint8Array.from(bytes)
      })()
    }),
    exists: vi.fn(async (_bucket, key) => objects.has(key)),
    stat: vi.fn(async (_bucket, key) => {
      const bytes = objects.get(key)
      return bytes ? { sizeBytes: bytes.byteLength } : null
    }),
    delete: vi.fn(async (_bucket, key) => {
      objects.delete(key)
    }),
    checkBuckets: vi.fn(async () => ({ sessions: true })),
    presign: vi.fn(async (request) => ({
      method: request.method,
      url: `https://s3.invalid/raditi-sessions/${request.key}?X-Amz-Signature=synthetic`,
      headers: (request.method === 'PUT' ? { 'if-none-match': '*' } : {}) as Record<string, string>,
      expiresAt: new Date(Date.now() + request.ttlMs),
    })),
  }
  const issued: Uint8Array[] = []
  const newKey = () => {
    const key = new Uint8Array(32).fill(7)
    issued.push(key)
    return key
  }
  const secrets = {
    transitDataKey: vi.fn(async () => ({ plaintext: newKey(), ciphertext: 'vault:v1:wrapped' })),
    transitDecryptDataKey: vi.fn(async () => newKey()),
  } as unknown as SecretStore
  const service = new SnapshotService(storage, secrets)
  /** A create-only presigned PUT, as S3 answers it: 412 when the key exists. */
  const putPresigned = (request: PresignedRequest, body: Uint8Array) => {
    const key = new URL(request.url).pathname.replace(/^\/raditi-sessions\//, '')
    if (request.method !== 'PUT' || request.headers['if-none-match'] !== '*')
      throw new Error('expected a create-only PUT')
    if (objects.has(key)) throw new Error('412 Precondition Failed')
    objects.set(key, Buffer.from(body))
    writes.push(key)
  }
  return { objects, writes, storage, secrets, issued, service, putPresigned }
}

/** The home part sealed like a TurnExecution does: with the data key, stored by the PUT. */
function sealedHome(
  f: ReturnType<typeof fixture>,
  home: Uint8Array,
): SealedElsewhere & {
  seal: Mock<SealedElsewhere['seal']>
} {
  return {
    sizeBytes: home.byteLength,
    ttlMs: () => 60_000,
    seal: vi.fn(async ({ base, dataKey, put }: TurnSealInput) => {
      const key = await dataKey()
      try {
        const { body, sealed } = sealSnapshotPart(base, 'home', home, key)
        f.putPresigned(put, body)
        return sealed
      } finally {
        key.fill(0)
      }
    }),
  }
}

function changeManifest(
  f: ReturnType<typeof fixture>,
  change: (value: Record<string, unknown>) => void,
) {
  const value = JSON.parse(Buffer.from(f.objects.get(manifestKey)!).toString()) as Record<
    string,
    unknown
  >
  change(value)
  f.objects.set(manifestKey, Buffer.from(JSON.stringify(value)))
}

describe('host snapshot lifecycle', () => {
  it('encrypts three parts, commits manifest last and loads exact bytes', async () => {
    const f = fixture()
    const original = await parts()
    const manifest = await f.service.save(metadata, original)
    expect(f.writes).toEqual([
      `${prefix}home.tar.zst`,
      `${prefix}untracked.tar.zst`,
      `${prefix}patch.diff`,
      manifestKey,
    ])
    expect(f.objects.get(`${prefix}home.tar.zst`)).not.toEqual(original.home)
    expect(new Set(manifest.parts.map((p) => p.encryption.iv)).size).toBe(3)
    expect(new Set(manifest.parts.map((p) => p.encryption.wrappedKey)).size).toBe(1)
    const loaded = await f.service.load(reference)
    for (const name of ['home', 'untracked', 'patch'] as const)
      expect(Buffer.from(loaded.archives[name]!)).toEqual(Buffer.from(original[name]))
    // One data key per snapshot: a single Vault round-trip per load.
    expect(f.secrets.transitDecryptDataKey).toHaveBeenCalledOnce()
    expect(f.issued).toHaveLength(2)
    expect(f.issued.every((key) => key.every((byte) => byte === 0))).toBe(true)
    expect(f.secrets.transitDataKey).toHaveBeenCalledWith('ws-ws1')
  })

  it('allows exactly one concurrent writer and never overwrites a committed snapshot', async () => {
    const f = fixture()
    const original = await parts()
    const results = await Promise.allSettled([
      f.service.save(metadata, original),
      f.service.save(metadata, original),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const before = [...f.objects].map(([k, v]) => [k, Buffer.from(v)])
    await expect(f.service.save(metadata, original)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect([...f.objects].map(([k, v]) => [k, Buffer.from(v)])).toEqual(before)
  })

  it('persists the checked bytes even if the caller mutates buffers during the Vault await', async () => {
    const f = fixture()
    const original = await parts()
    const expected = Object.fromEntries(
      Object.entries(original).map(([name, bytes]) => [name, Buffer.from(bytes)]),
    )
    const issue = vi.mocked(f.secrets.transitDataKey).getMockImplementation()!
    vi.mocked(f.secrets.transitDataKey).mockImplementationOnce(async (...args) => {
      original.home.fill(0)
      original.untracked.fill(0)
      original.patch.fill(0)
      return issue(...args)
    })
    await f.service.save(metadata, original)
    const loaded = await f.service.load(reference)
    expect(loaded.archives).toEqual(expected)
  })

  it('writes nothing when Vault fails, so the same turn can be saved again', async () => {
    const f = fixture()
    const original = await parts()
    vi.mocked(f.secrets.transitDataKey).mockRejectedValueOnce(new Error('503 from Transit'))
    await expect(f.service.save(metadata, original)).rejects.toMatchObject({
      code: 'SNAPSHOT_NOT_WRITTEN',
    })
    expect(f.storage.putIfAbsent).not.toHaveBeenCalled()
    expect(f.objects.size).toBe(0)
    const claim = vi.mocked(f.storage.putIfAbsent).getMockImplementation()!
    vi.mocked(f.storage.putIfAbsent).mockImplementationOnce(async (...args) => {
      // The data key is gone before the first request to storage.
      if (!f.issued.every((key) => key.every((byte) => byte === 0))) throw new Error('live key')
      return claim(...args)
    })
    await expect(f.service.save(metadata, original)).resolves.toHaveProperty('turn', 1)
    await expect(f.service.load(reference)).resolves.toHaveProperty('manifest.turn', 1)
  })

  it('treats a failed reservation request as ambiguous', async () => {
    const f = fixture()
    const original = await parts()
    const claim = vi.mocked(f.storage.putIfAbsent).getMockImplementation()!
    vi.mocked(f.storage.putIfAbsent).mockImplementationOnce(async (...args) => {
      await claim(...args)
      throw new Error('response lost after the reservation')
    })
    await expect(f.service.save(metadata, original)).rejects.toMatchObject({
      code: 'SNAPSHOT_SAVE_FAILED',
    })
    expect(f.storage.put).not.toHaveBeenCalled()
    expect(f.storage.delete).not.toHaveBeenCalled()
    await expect(f.service.save(metadata, original)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('retains an incomplete reservation after an upload error and refuses reuse', async () => {
    const f = fixture()
    const original = await parts()
    const put = vi.mocked(f.storage.put).getMockImplementation()!
    vi.mocked(f.storage.put)
      .mockImplementationOnce(put)
      .mockRejectedValueOnce(new Error('private service error'))
    await expect(f.service.save(metadata, original)).rejects.toMatchObject({
      code: 'SNAPSHOT_SAVE_FAILED',
    })
    expect(f.objects.has(`${prefix}reservation.json`)).toBe(true)
    expect(f.objects.has(manifestKey)).toBe(false)
    expect(f.storage.delete).not.toHaveBeenCalled()
    await expect(f.service.save(metadata, original)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('preserves a committed snapshot if the manifest response is lost', async () => {
    const f = fixture()
    const original = await parts()
    const put = vi.mocked(f.storage.put).getMockImplementation()!
    vi.mocked(f.storage.put).mockImplementation(async (...args) => {
      await put(...args)
      if (args[1] === manifestKey) throw new Error('connection lost after commit')
    })
    await expect(f.service.save(metadata, original)).rejects.toMatchObject({
      code: 'SNAPSHOT_SAVE_FAILED',
    })
    expect(f.objects.size).toBe(5)
    await expect(f.service.load(reference)).resolves.toHaveProperty('manifest.turn', 1)
  })

  it.each(['workspace', 'image', 'version', 'home'] as const)(
    'rejects incompatible %s before asking Vault',
    async (kind) => {
      const f = fixture()
      await f.service.save(metadata, await parts())
      const ref = structuredClone(reference)
      if (kind === 'workspace') ref.workspaceId = 'other'
      if (kind === 'image') ref.image = `registry/raditi@sha256:${'e'.repeat(64)}`
      if (kind === 'version') ref.driver.version = '0.200.0'
      if (kind === 'home') ref.home.include = ['other']
      await expect(f.service.load(ref)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(f.secrets.transitDecryptDataKey).not.toHaveBeenCalled()
      expect(f.issued.every((key) => key.every((byte) => byte === 0))).toBe(true)
    },
  )

  it.each(['codex', 'kimi', 'qwen'])(
    'loads no snapshot of a session of the removed driver %s: its objects stay as history',
    async (id) => {
      const f = fixture()
      await f.service.save(metadata, await parts())
      const stored = f.objects.size
      // The reference a saved plan of that shell carries, and the manifest it left in S3.
      const earlier = { ...reference, driver: { ...reference.driver, id } }
      for (const read of [
        () => f.service.load(earlier as typeof reference),
        () => f.service.restoreSource(earlier as typeof reference, 30_000),
      ])
        await expect(read()).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: 'Invalid snapshot reference',
        })
      changeManifest(f, (m) => {
        ;(m.driver as Record<string, unknown>).id = id
      })
      await expect(f.service.load(reference)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Invalid snapshot manifest',
      })
      // Refused before any key is asked for or any link is signed; nothing is removed.
      expect(f.secrets.transitDecryptDataKey).not.toHaveBeenCalled()
      expect(f.storage.presign).not.toHaveBeenCalled()
      expect(f.objects.size).toBe(stored)
    },
  )

  it.each(['ciphertext', 'tag', 'resume-metadata', 'git-metadata', 'missing-part', 'foreign-key'])(
    'refuses %s and zeroes every data key',
    async (kind) => {
      const f = fixture()
      await f.service.save(metadata, await parts())
      if (kind === 'ciphertext') {
        const bytes = f.objects.get(`${prefix}untracked.tar.zst`)!
        bytes[0] = (bytes[0] ?? 0) ^ 1
      }
      if (kind === 'missing-part') f.objects.delete(`${prefix}patch.diff`)
      if (kind === 'git-metadata')
        changeManifest(f, (m) => {
          ;(m.git as Record<string, unknown>).headSha = 'e'.repeat(40)
        })
      if (kind === 'resume-metadata')
        changeManifest(f, (m) => {
          ;(m.driver as Record<string, unknown>).nativeSessionId = 'wrong-thread'
        })
      if (kind === 'tag' || kind === 'foreign-key')
        changeManifest(f, (m) => {
          const ps = m.parts as Array<{ encryption: Record<string, unknown> }>
          ps[1]!.encryption[kind === 'tag' ? 'tag' : 'keyId'] =
            kind === 'tag' ? 'f'.repeat(32) : 'ws-other'
        })
      await expect(f.service.load(reference)).rejects.toBeDefined()
      expect(f.issued.every((key) => key.every((byte) => byte === 0))).toBe(true)
    },
  )

  it('rejects parts wrapped with different data keys before asking Vault', async () => {
    const f = fixture()
    await f.service.save(metadata, await parts())
    changeManifest(f, (m) => {
      const ps = m.parts as Array<{ encryption: Record<string, unknown> }>
      ps[2]!.encryption.wrappedKey = 'vault:v1:other'
    })
    await expect(f.service.load(reference)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(f.secrets.transitDecryptDataKey).not.toHaveBeenCalled()
  })

  it.each(['task', 'time', 'removed'])(
    'authenticates publication recovery metadata: %s',
    async (kind) => {
      const f = fixture()
      await f.service.save(
        {
          ...metadata,
          git: {
            ...metadata.git,
            publication: {
              taskId: 'task-1',
              committedAt: '2026-09-26T12:00:00.000Z',
            },
          },
        },
        await parts(),
      )
      expect((await f.service.load(reference)).manifest.git?.publication?.taskId).toBe('task-1')
      changeManifest(f, (m) => {
        const git = m.git as Record<string, unknown>
        if (kind === 'removed') delete git.publication
        else
          (git.publication as Record<string, unknown>)[kind === 'task' ? 'taskId' : 'committedAt'] =
            kind === 'task' ? 'other-task' : '2026-09-26T13:00:00.000Z'
      })
      await expect(f.service.load(reference)).rejects.toBeDefined()
    },
  )

  it('does not commit an unsafe archive or request a data key', async () => {
    const f = fixture()
    const original = await parts()
    original.untracked = await archive('../escape', 'bad')
    await expect(f.service.save(metadata, original)).rejects.toMatchObject({
      code: 'SNAPSHOT_NOT_WRITTEN',
    })
    expect(f.storage.putIfAbsent).not.toHaveBeenCalled()
    expect(f.secrets.transitDataKey).not.toHaveBeenCalled()
  })

  it('reports an oversized session archive as too large, without asking Vault or writing', async () => {
    const f = fixture()
    const original = await parts()
    original.home = Buffer.alloc(snapshotLimits.archiveBytes + 1)
    await expect(f.service.save(metadata, original)).rejects.toMatchObject({
      code: 'SNAPSHOT_TOO_LARGE',
      httpStatus: 413,
    })
    expect(f.secrets.transitDataKey).not.toHaveBeenCalled()
    expect(f.objects.size).toBe(0)
  })

  it('reports invalid metadata as not written, so the turn can be retried', async () => {
    const f = fixture()
    await expect(
      f.service.save(
        { ...metadata, driver: { id: sampleDriverId, version: 'bad version' } },
        await parts(),
      ),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
    expect(f.secrets.transitDataKey).not.toHaveBeenCalled()
    expect(f.objects.size).toBe(0)
    await expect(f.service.save(metadata, await parts())).resolves.toHaveProperty('turn', 1)
  })

  it('writes nothing when aborted while the data key is pending', async () => {
    const f = fixture()
    const issue = vi.mocked(f.secrets.transitDataKey).getMockImplementation()!
    const pending = Promise.withResolvers<void>()
    vi.mocked(f.secrets.transitDataKey).mockImplementationOnce(async (...args) => {
      await pending.promise
      return issue(...args)
    })
    const controller = new AbortController()
    const saving = f.service.save(metadata, await parts(), controller.signal)
    await vi.waitFor(() => expect(f.secrets.transitDataKey).toHaveBeenCalledOnce())
    controller.abort()
    pending.resolve()
    await expect(saving).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
    expect(f.storage.putIfAbsent).not.toHaveBeenCalled()
    expect(f.storage.put).not.toHaveBeenCalled()
    expect(f.objects.size).toBe(0)
    expect(f.issued.every((key) => key.every((byte) => byte === 0))).toBe(true)
  })

  it('never commits a manifest once aborted after its reservation', async () => {
    const f = fixture()
    const controller = new AbortController()
    const claim = vi.mocked(f.storage.putIfAbsent).getMockImplementation()!
    vi.mocked(f.storage.putIfAbsent).mockImplementationOnce(async (...args) => {
      const claimed = await claim(...args)
      controller.abort()
      return claimed
    })
    await expect(f.service.save(metadata, await parts(), controller.signal)).rejects.toMatchObject({
      code: 'SNAPSHOT_SAVE_FAILED',
    })
    expect(f.objects.has(`${prefix}reservation.json`)).toBe(true)
    expect(f.storage.put).not.toHaveBeenCalled()
    expect(f.objects.has(manifestKey)).toBe(false)
  })

  it('does not remove objects after an ambiguous upload failure', async () => {
    const f = fixture()
    vi.mocked(f.storage.put).mockRejectedValue(new Error('upload failed'))
    await expect(f.service.save(metadata, await parts())).rejects.toMatchObject({
      code: 'SNAPSHOT_SAVE_FAILED',
    })
    expect(f.objects.has(`${prefix}reservation.json`)).toBe(true)
    expect(f.objects.has(manifestKey)).toBe(false)
  })
})

describe('home part sealed by a turn executor', () => {
  it('reserves first, admits the PUT home only after reading it back and commits last', async () => {
    const f = fixture()
    const original = await parts()
    const home = sealedHome(f, original.home)
    const manifest = await f.service.save(metadata, { ...original, home })
    expect(f.writes).toEqual([
      `${prefix}home.tar.zst`,
      `${prefix}untracked.tar.zst`,
      `${prefix}patch.diff`,
      manifestKey,
    ])
    expect(f.storage.putIfAbsent).toHaveBeenCalledBefore(home.seal)
    // A create-only PUT of exactly the archive size: AES-GCM adds no padding.
    expect(f.storage.presign).toHaveBeenCalledWith({
      bucket: 'sessions',
      key: `${prefix}home.tar.zst`,
      method: 'PUT',
      sizeBytes: original.home.byteLength,
      ttlMs: 60_000,
    })
    const input = home.seal.mock.calls[0]![0]
    expect(input.base).toMatchObject({ git: { headSha: metadata.git.headSha }, schemaVersion: 1 })
    expect(input.base.createdAt).toBe(manifest.createdAt)
    // One data key: the executor's copy and core's parts share the wrapped key.
    expect(new Set(manifest.parts.map((p) => p.encryption.wrappedKey)).size).toBe(1)
    const loaded = await f.service.load(reference)
    for (const name of ['home', 'untracked', 'patch'] as const)
      expect(Buffer.from(loaded.archives[name]!)).toEqual(Buffer.from(original[name]))
    expect(f.issued.every((key) => key.every((byte) => byte === 0))).toBe(true)
  })

  it.each([
    ['a different hash', { sha256: 'f'.repeat(64) }],
    ['a different size', { sizeBytes: 1 }],
    ['a different tag', { tag: 'f'.repeat(32) }],
  ])('keeps a reported part with %s ambiguous and commits nothing', async (_, change) => {
    const f = fixture()
    const original = await parts()
    const home = sealedHome(f, original.home)
    const seal = home.seal.getMockImplementation()!
    home.seal.mockImplementation(async (input) => ({ ...(await seal(input)), ...change }))
    await expect(f.service.save(metadata, { ...original, home })).rejects.toMatchObject({
      code: 'SNAPSHOT_SAVE_FAILED',
    })
    expect(f.objects.has(`${prefix}reservation.json`)).toBe(true)
    expect(f.objects.has(manifestKey)).toBe(false)
    expect(f.writes).toEqual([`${prefix}home.tar.zst`])
  })

  it('refuses a home part whose archive is not a valid session archive', async () => {
    const f = fixture()
    const original = await parts()
    const home = sealedHome(f, await archive('../escape', 'bad'))
    await expect(f.service.save(metadata, { ...original, home })).rejects.toMatchObject({
      code: 'SNAPSHOT_SAVE_FAILED',
    })
    expect(f.objects.has(manifestKey)).toBe(false)
  })

  it.each([
    ['says nothing was written', new DomainError('SNAPSHOT_NOT_WRITTEN', 'synthetic', 502)],
    ['is too large', new DomainError('SNAPSHOT_TOO_LARGE', 'synthetic', 413)],
    ['fails', new Error('put reply lost')],
  ])('keeps a sealer that %s ambiguous: the reservation is already written', async (_, error) => {
    const f = fixture()
    const original = await parts()
    const home = sealedHome(f, original.home)
    home.seal.mockRejectedValueOnce(error)
    await expect(f.service.save(metadata, { ...original, home })).rejects.toMatchObject({
      code: 'SNAPSHOT_SAVE_FAILED',
    })
    expect(f.objects.has(`${prefix}reservation.json`)).toBe(true)
  })

  it('refuses an oversized home before asking Vault or writing', async () => {
    const f = fixture()
    const original = await parts()
    const home = { ...sealedHome(f, original.home), sizeBytes: snapshotLimits.archiveBytes + 1 }
    await expect(f.service.save(metadata, { ...original, home })).rejects.toMatchObject({
      code: 'SNAPSHOT_TOO_LARGE',
      httpStatus: 413,
    })
    expect(f.secrets.transitDataKey).not.toHaveBeenCalled()
    expect(f.objects.size).toBe(0)
  })

  it('never hands out the PUT once aborted after the reservation', async () => {
    const f = fixture()
    const original = await parts()
    const home = sealedHome(f, original.home)
    const controller = new AbortController()
    const claim = vi.mocked(f.storage.putIfAbsent).getMockImplementation()!
    vi.mocked(f.storage.putIfAbsent).mockImplementationOnce(async (...args) => {
      const claimed = await claim(...args)
      controller.abort()
      return claimed
    })
    await expect(
      f.service.save(metadata, { ...original, home }, controller.signal),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_SAVE_FAILED' })
    expect(f.storage.presign).not.toHaveBeenCalled()
    expect(home.seal).not.toHaveBeenCalled()
  })
})

describe('restore source for a turn executor', () => {
  it('checks the manifest and presigns only the three parts of that turn', async () => {
    const f = fixture()
    const original = await parts()
    await f.service.save(metadata, original)
    const source = await f.service.restoreSource(reference, 30_000)
    expect(source.manifest.turn).toBe(1)
    for (const name of ['home', 'untracked', 'patch'] as const)
      expect(source.parts[name]).toMatchObject({ method: 'GET' })
    expect(vi.mocked(f.storage.presign).mock.calls.map(([request]) => request)).toEqual([
      { bucket: 'sessions', key: `${prefix}home.tar.zst`, method: 'GET', ttlMs: 30_000 },
      { bucket: 'sessions', key: `${prefix}untracked.tar.zst`, method: 'GET', ttlMs: 30_000 },
      { bucket: 'sessions', key: `${prefix}patch.diff`, method: 'GET', ttlMs: 30_000 },
    ])
    // No part is read and no key unwrapped until the executor asks for it.
    expect(f.secrets.transitDecryptDataKey).not.toHaveBeenCalled()
    const key = await source.dataKey()
    expect(key).toHaveLength(32)
    expect(f.secrets.transitDecryptDataKey).toHaveBeenCalledWith('ws-ws1', 'vault:v1:wrapped')
  })

  it('refuses an incompatible reference before presigning anything', async () => {
    const f = fixture()
    await f.service.save(metadata, await parts())
    await expect(
      f.service.restoreSource({ ...reference, workspaceId: 'other' }, 30_000),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(f.service.restoreSource({ ...reference, turn: 2 }, 30_000)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(f.storage.presign).not.toHaveBeenCalled()
  })
})

describe('a snapshot without a repository (docs/plan/57-browser-tasks.md, Б4)', () => {
  const { git: _git, ...homeOnly } = metadata

  it('stores the home part alone and a manifest without git, and gives back only that part', async () => {
    const f = fixture()
    const original = await parts()
    const home = sealedHome(f, original.home)
    const manifest = await f.service.save(homeOnly, { home })
    expect(f.writes).toEqual([`${prefix}home.tar.zst`, manifestKey])
    expect(manifest.git).toBeUndefined()
    expect(manifest.parts.map((part) => part.name)).toEqual(['home'])
    expect(home.seal.mock.calls[0]![0].base).not.toHaveProperty('git')
    const stored = JSON.parse(Buffer.from(f.objects.get(manifestKey)!).toString()) as object
    expect(stored).not.toHaveProperty('git')

    const loaded = await f.service.load(reference)
    expect(Object.keys(loaded.archives)).toEqual(['home'])
    expect(Buffer.from(loaded.archives.home)).toEqual(Buffer.from(original.home))
    expect(f.issued.every((key) => key.every((byte) => byte === 0))).toBe(true)

    vi.mocked(f.storage.presign).mockClear()
    const source = await f.service.restoreSource(reference, 30_000)
    expect(Object.keys(source.parts)).toEqual(['home'])
    expect(vi.mocked(f.storage.presign).mock.calls.map(([request]) => request)).toEqual([
      { bucket: 'sessions', key: `${prefix}home.tar.zst`, method: 'GET', ttlMs: 30_000 },
    ])
  })

  it('seals bytes core holds for it the same way', async () => {
    const f = fixture()
    const original = await parts()
    await f.service.save(homeOnly, { home: original.home })
    expect(f.writes).toEqual([`${prefix}home.tar.zst`, manifestKey])
    const loaded = await f.service.load(reference)
    expect(Buffer.from(loaded.archives.home)).toEqual(Buffer.from(original.home))
  })

  it('never mixes the shapes: refused before Vault is asked or anything is written', async () => {
    const original = await parts()
    for (const [shape, given] of [
      [homeOnly, original],
      [homeOnly, { home: original.home, patch: original.patch }],
      [metadata, { home: original.home }],
    ] as const) {
      const f = fixture()
      await expect(
        f.service.save(shape, given as Parameters<SnapshotService['save']>[1]),
      ).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN' })
      expect(f.secrets.transitDataKey).not.toHaveBeenCalled()
      expect(f.writes).toEqual([])
    }
  })

  it('cannot be read as the other shape: a git block added or removed fails the load', async () => {
    const original = await parts()
    const withGit = fixture()
    await withGit.service.save(homeOnly, { home: original.home })
    changeManifest(withGit, (m) => {
      m.git = metadata.git
    })
    await expect(withGit.service.load(reference)).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    // A manifest of a turn with a repository loses its git block and two of its parts: the home
    // part was sealed with the git fields in its AAD and does not open.
    const withoutGit = fixture()
    await withoutGit.service.save(metadata, original)
    changeManifest(withoutGit, (m) => {
      delete m.git
      m.parts = (m.parts as Array<{ name: string }>).filter((part) => part.name === 'home')
    })
    await expect(withoutGit.service.load(reference)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })
})
