import { zstdCompressSync } from 'node:zlib'

import {
  type ObjectStorage,
  type Sandbox,
  type SecretStore,
  type SnapshotMetadata,
  type SnapshotReference,
  turnSnapshotPrefix,
} from '@repo/domain'
import { pack } from 'tar-stream'
import { describe, expect, it, vi } from 'vitest'

import { SnapshotService } from './snapshot.service.ts'
import { SandboxSnapshotTransport } from './sandbox-snapshot.ts'

const metadata: SnapshotMetadata = {
  workspaceId: 'ws1',
  sessionId: 's1',
  turn: 1,
  image: `registry/raditi@sha256:${'a'.repeat(64)}`,
  driver: { id: 'codex', version: '0.157.1', nativeSessionId: 'thread-1' },
  git: { provider: 'gitea', branch: 'task/t1', baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) },
  home: { root: '/agent-home/codex', include: ['sessions'], exclude: [] },
}
const reference: SnapshotReference = {
  workspaceId: metadata.workspaceId,
  sessionId: metadata.sessionId,
  turn: metadata.turn,
  image: metadata.image,
  driver: { id: 'codex', version: '0.157.1' },
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
    home: await archive('sessions/turn.jsonl', 'native-session-data'),
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
    delete: vi.fn(async (_bucket, key) => {
      objects.delete(key)
    }),
    checkBuckets: vi.fn(async () => ({ sessions: true })),
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
  const transport = new SandboxSnapshotTransport()
  const restore = vi.spyOn(transport, 'restore').mockResolvedValue(undefined)
  const service = new SnapshotService(storage, secrets, transport)
  const sandbox = { labels: { workspaceId: 'ws1', sessionId: 's1', turn: 2 } } as Sandbox
  return { objects, writes, storage, secrets, issued, restore, service, sandbox }
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
  it('encrypts three parts, commits manifest last and restores exact bytes', async () => {
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
    const loaded = await f.service.load(reference)
    for (const name of ['home', 'untracked', 'patch'] as const)
      expect(Buffer.from(loaded.archives[name])).toEqual(Buffer.from(original[name]))
    const restored = await f.service.restore(f.sandbox, reference)
    expect(f.restore).toHaveBeenCalledOnce()
    expect(restored.patch).toEqual(original.patch)
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

  it('persists the checked bytes even if the caller mutates buffers during a storage await', async () => {
    const f = fixture()
    const original = await parts()
    const expected = Object.fromEntries(
      Object.entries(original).map(([name, bytes]) => [name, Buffer.from(bytes)]),
    )
    vi.mocked(f.storage.exists).mockImplementation(async () => {
      original.home.fill(0)
      original.untracked.fill(0)
      original.patch.fill(0)
      return false
    })
    await f.service.save(metadata, original)
    const loaded = await f.service.load(reference)
    expect(loaded.archives).toEqual(expected)
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
    'rejects incompatible %s before asking Vault or restoring',
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
      expect(f.restore).not.toHaveBeenCalled()
      expect(f.issued.every((key) => key.every((byte) => byte === 0))).toBe(true)
    },
  )

  it.each(['ciphertext', 'tag', 'resume-metadata', 'git-metadata', 'missing-part', 'foreign-key'])(
    'refuses %s without writing to a sandbox',
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
      await expect(f.service.restore(f.sandbox, reference)).rejects.toBeDefined()
      expect(f.restore).not.toHaveBeenCalled()
      expect(f.issued.every((key) => key.every((byte) => byte === 0))).toBe(true)
    },
  )

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
      expect((await f.service.load(reference)).manifest.git.publication?.taskId).toBe('task-1')
      changeManifest(f, (m) => {
        const git = m.git as Record<string, unknown>
        if (kind === 'removed') delete git.publication
        else
          (git.publication as Record<string, unknown>)[kind === 'task' ? 'taskId' : 'committedAt'] =
            kind === 'task' ? 'other-task' : '2026-09-26T13:00:00.000Z'
      })
      await expect(f.service.restore(f.sandbox, reference)).rejects.toBeDefined()
      expect(f.restore).not.toHaveBeenCalled()
    },
  )

  it('does not commit an unsafe archive or request a data key', async () => {
    const f = fixture()
    const original = await parts()
    original.untracked = await archive('../escape', 'bad')
    await expect(f.service.save(metadata, original)).rejects.toBeDefined()
    expect(f.storage.putIfAbsent).not.toHaveBeenCalled()
    expect(f.secrets.transitDataKey).not.toHaveBeenCalled()
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

  it('rejects a foreign target sandbox', async () => {
    const f = fixture()
    f.sandbox.labels.workspaceId = 'other'
    await expect(f.service.restore(f.sandbox, reference)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(f.storage.get).not.toHaveBeenCalled()
  })
})
