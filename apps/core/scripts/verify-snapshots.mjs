/* global AbortSignal, Buffer, URL, console, fetch, process */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { turnSnapshotPrefix } from '@repo/domain'
import { createS3ObjectStorage, storageConfigFromEnv } from '@repo/storage'
import { createVaultSecretStore, vaultConfigFromEnv } from '@repo/vault'
import { pack } from 'tar-stream'

import { openSnapshotParts, sealSnapshotPart } from '@repo/snapshots'
import { SnapshotService } from '../dist/sessions/snapshot.service.js'
import { sampleDriverId } from '../src/testing/ids.ts'

// Explicit local integration check: no models, client data or production endpoints.
const storageConfig = storageConfigFromEnv(process.env)
const vaultConfig = vaultConfigFromEnv(process.env)
for (const endpoint of [storageConfig.endpoint, vaultConfig.addr]) {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname))
}
assert(process.env.APP_ENV !== 'production' && vaultConfig.token && !vaultConfig.appRole)

const storage = createS3ObjectStorage(storageConfig)
const secrets = createVaultSecretStore(vaultConfig)
const id = `p1verify-${randomUUID()}`
const keyId = `ws-${id}`
const prefix = turnSnapshotPrefix(id, 1)
// Turn 2 is saved the way a turn executor seals home: through a presigned create-only PUT.
const prefix2 = turnSnapshotPrefix(id, 2)
const partNames = ['reservation.json', 'home.tar.zst', 'untracked.tar.zst', 'patch.diff']
const objectKeys = [
  ...[...partNames, 'manifest.json', 'conditional-probe'].map((name) => `${prefix}${name}`),
  ...[...partNames, 'manifest.json'].map((name) => `${prefix2}${name}`),
]
const presigned = (request, body) =>
  fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
let keyCreated = false

async function vault(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${vaultConfig.addr.replace(/\/$/, '')}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': vaultConfig.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  assert(response.ok, `Local Vault setup failed (${response.status})`)
  return response.status === 204 ? null : response.json()
}

async function archive(name, value) {
  const stream = pack()
  stream.entry({ name, mode: 0o600 }, value)
  stream.finalize()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return zstdCompressSync(Buffer.concat(chunks))
}

try {
  const mounts = await vault('sys/mounts')
  if (!mounts.data['transit/']) await vault('sys/mounts/transit', { type: 'transit' })
  await vault(`transit/keys/${keyId}`, { type: 'aes256-gcm96' })
  keyCreated = true

  const claims = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      storage.putIfAbsent('sessions', `${prefix}conditional-probe`, Buffer.from(String(index))),
    ),
  )
  assert.equal(claims.filter(Boolean).length, 1, 'S3 must enforce atomic conditional PUT')

  // The session state the sample driver names: its session database and the journal of it.
  const home = {
    root: `/agent-home/${sampleDriverId}`,
    include: ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'],
    exclude: [],
  }
  const driver = { id: sampleDriverId, version: '0.0.0-verify' }
  const metadata = {
    workspaceId: id,
    sessionId: id,
    turn: 1,
    image: `registry/raditi@sha256:${'a'.repeat(64)}`,
    driver: { ...driver, nativeSessionId: id },
    git: {
      provider: 'gitea',
      branch: 'task/p1-verification',
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
    },
    home,
  }
  const reference = {
    workspaceId: id,
    sessionId: id,
    turn: 1,
    image: metadata.image,
    driver,
    home,
  }
  const parts = {
    home: await archive(home.include[0], 'synthetic conversation'),
    untracked: await archive('draft.txt', 'synthetic draft'),
    patch: Buffer.from('synthetic patch\0'),
  }
  const service = new SnapshotService(storage, secrets)
  await service.save(metadata, parts)
  const loaded = await service.load(reference)
  for (const name of ['home', 'untracked', 'patch'])
    assert.deepEqual(Buffer.from(loaded.archives[name]), parts[name])
  await assert.rejects(service.save(metadata, parts), { code: 'CONFLICT' })
  await assert.rejects(service.load({ ...reference, workspaceId: `${id}-other` }), {
    code: 'CONFLICT',
  })

  let replayed
  const sealedHome = {
    sizeBytes: parts.home.byteLength,
    ttlMs: () => 60_000,
    async seal({ base, dataKey, put }) {
      const key = await dataKey()
      try {
        const { body, sealed } = sealSnapshotPart(base, 'home', parts.home, key)
        assert.equal((await presigned(put, body)).status, 200)
        replayed = (await presigned(put, body)).status
        return sealed
      } finally {
        key.fill(0)
      }
    },
  }
  await service.save({ ...metadata, turn: 2 }, { ...parts, home: sealedHome })
  assert.equal(replayed, 412, 'A presigned PUT must be create-only')
  const source = await service.restoreSource({ ...reference, turn: 2 }, 60_000)
  const stored = []
  for (const part of source.manifest.parts) {
    const response = await presigned(source.parts[part.name])
    assert.equal(response.status, 200)
    stored.push({ part, body: Buffer.from(await response.arrayBuffer()) })
  }
  const restored = await openSnapshotParts(source.manifest, stored, home, source.dataKey)
  for (const name of ['home', 'untracked', 'patch'])
    assert.deepEqual(Buffer.from(restored[name]), parts[name])
  console.log(
    'Snapshot integration passed: S3 conditional PUT (12 contenders), Vault Transit, encrypted round trip, immutable turn, workspace isolation, home sealed through a create-only presigned PUT and restored through presigned GETs.',
  )
} finally {
  const cleanup = await Promise.allSettled(objectKeys.map((key) => storage.delete('sessions', key)))
  if (keyCreated) {
    await vault(`transit/keys/${keyId}/config`, { deletion_allowed: true })
    await vault(`transit/keys/${keyId}`, undefined, 'DELETE')
  }
  assert(
    cleanup.every((result) => result.status === 'fulfilled'),
    'Could not remove temporary S3 objects',
  )
}
