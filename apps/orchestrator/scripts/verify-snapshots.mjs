/* global AbortSignal, Buffer, URL, console, fetch, process */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { turnSnapshotPrefix } from '@repo/domain'
import { createS3ObjectStorage, storageConfigFromEnv } from '@repo/storage'
import { createVaultSecretStore, vaultConfigFromEnv } from '@repo/vault'
import { pack } from 'tar-stream'

import { SnapshotService } from '../dist/sessions/snapshot.service.js'

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
const objectNames = [
  'reservation.json',
  'home.tar.zst',
  'untracked.tar.zst',
  'patch.diff',
  'manifest.json',
  'conditional-probe',
]
let keyCreated = false

async function vault(path, body) {
  const response = await fetch(`${vaultConfig.addr.replace(/\/$/, '')}/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
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

  const home = { root: '/agent-home/codex', include: ['sessions'], exclude: [] }
  const metadata = {
    workspaceId: id,
    sessionId: id,
    turn: 1,
    image: `registry/raditi@sha256:${'a'.repeat(64)}`,
    driver: { id: 'codex', version: '0.157.1', nativeSessionId: id },
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
    driver: { id: 'codex', version: '0.157.1' },
    home,
  }
  const parts = {
    home: await archive('sessions/test.jsonl', 'synthetic conversation'),
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
  console.log(
    'Snapshot integration passed: S3 conditional PUT (12 contenders), Vault Transit, encrypted round trip, immutable turn, workspace isolation.',
  )
} finally {
  const cleanup = await Promise.allSettled(
    objectNames.map((name) => storage.delete('sessions', `${prefix}${name}`)),
  )
  if (keyCreated) {
    await vault(`transit/keys/${keyId}/config`, { deletion_allowed: true })
    const response = await fetch(
      `${vaultConfig.addr.replace(/\/$/, '')}/v1/transit/keys/${keyId}`,
      {
        method: 'DELETE',
        headers: { 'X-Vault-Token': vaultConfig.token },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    )
    assert(response.ok, 'Could not remove the temporary local Transit key')
  }
  assert(
    cleanup.every((result) => result.status === 'fulfilled'),
    'Could not remove temporary S3 objects',
  )
}
