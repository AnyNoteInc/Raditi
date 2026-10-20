import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'

import type { DatabaseCopier, DatabaseCopyInput } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import {
  openPreviewSeed,
  previewSeedKey,
  storePreviewSeed,
  type PreviewSeedRef,
} from './preview-seed.ts'

const ref: PreviewSeedRef = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  siteId: '00000000-0000-4000-8000-000000000002',
  previewId: '00000000-0000-4000-8000-000000000003',
  releaseId: null,
}
const input = {
  access: {},
  tablePrefix: 'wp_',
  charset: 'utf8mb4',
  collation: null,
  policy: { engine: 'mysql', tables: [], overrides: [] },
} as unknown as DatabaseCopyInput

async function bytesOf(body: Uint8Array | AsyncIterable<Uint8Array>): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body)
  const parts: Buffer[] = []
  for await (const chunk of body) parts.push(Buffer.from(chunk))
  return Buffer.concat(parts)
}

function deps(chunks: Uint8Array[]) {
  const objects = new Map<string, Buffer>()
  const keys = new Map<string, Uint8Array>()
  const copier: DatabaseCopier = {
    async copy(_input, write) {
      for (const chunk of chunks) await write(chunk)
      return { tables: 1, structureOnly: 0, rows: 1, bytes: 1, sha256: 'x', serverVersion: null }
    },
  }
  return {
    objects,
    copier,
    storage: {
      async put(_bucket: string, key: string, body: Uint8Array | AsyncIterable<Uint8Array>) {
        objects.set(key, await bytesOf(body))
      },
      async get(_bucket: string, key: string) {
        const body = objects.get(key)
        return body
          ? (async function* () {
              yield body
            })()
          : null
      },
    },
    secrets: {
      async transitDataKey(key: string) {
        const plaintext = randomBytes(32)
        const ciphertext = `vault:v1:${randomBytes(8).toString('hex')}`
        keys.set(`${key}|${ciphertext}`, Buffer.from(plaintext))
        return { plaintext, ciphertext }
      },
      async transitDecryptDataKey(key: string, ciphertext: string) {
        const found = keys.get(`${key}|${ciphertext}`)
        if (!found) throw new Error('unknown key')
        return Buffer.from(found)
      },
    },
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function read(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = []
  for await (const chunk of stream) parts.push(Buffer.from(chunk))
  return Buffer.concat(parts).toString('utf8')
}

describe('the seed of a preview', () => {
  it('is sealed under the key of its preview and opens to the same SQL', async () => {
    const sql = ['INSERT INTO `wp_posts` VALUES (1);\n', 'INSERT INTO `wp_options` VALUES (2);\n']
    const d = deps(sql.map((line) => Buffer.from(line)))
    const stored = await storePreviewSeed(d, ref, input, new AbortController().signal)
    expect(stored.key).toBe(previewSeedKey(ref.siteId, ref.previewId))
    expect(stored.key).toBe(`previews/${ref.siteId}/${ref.previewId}/seed.sql.zst.enc`)
    const object = d.objects.get(stored.key)!
    expect(object.includes(Buffer.from('wp_posts'))).toBe(false)
    expect(await read(await openPreviewSeed(d, ref, stored))).toBe(sql.join(''))
  })

  it('refuses a seed that is not what the row says, or of another preview', async () => {
    const d = deps([Buffer.from('SELECT 1;\n')])
    const stored = await storePreviewSeed(d, ref, input, new AbortController().signal)
    await expect(
      openPreviewSeed(d, ref, { ...stored, sha256: 'f'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'PREVIEW_SEED_INVALID' })
    await expect(
      openPreviewSeed(d, { ...ref, releaseId: '00000000-0000-4000-8000-000000000009' }, stored),
    ).rejects.toMatchObject({ code: 'PREVIEW_SEED_INVALID' })
    await expect(
      openPreviewSeed(d, { ...ref, previewId: '00000000-0000-4000-8000-000000000004' }, stored),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    d.objects.clear()
    await expect(openPreviewSeed(d, ref, stored)).rejects.toMatchObject({
      code: 'PREVIEW_SEED_MISSING',
    })
  })

  it('is sealed in chunks and authenticated whole before any of it is given out', async () => {
    // Random lines compress poorly: the copy comes out of zstd in many chunks.
    const lines = Array.from({ length: 2000 }, () => `${randomBytes(48).toString('hex')}\n`)
    const d = deps(lines.map((line) => Buffer.from(line)))
    const stored = await storePreviewSeed(d, ref, input, new AbortController().signal)
    const object = d.objects.get(stored.key)!
    expect(object.subarray(0, 14).toString('latin1')).toBe('RADITI-SEED-2\n')
    expect(await read(await openPreviewSeed(d, ref, stored))).toBe(lines.join(''))

    // A flipped byte of the ciphertext, under a SHA-256 the row would agree with.
    const tampered = Buffer.from(object)
    tampered[tampered.length - 40]! ^= 1
    d.objects.set(stored.key, tampered)
    await expect(
      openPreviewSeed(d, ref, { key: stored.key, sha256: sha256(tampered) }),
    ).rejects.toMatchObject({ code: 'PREVIEW_SEED_INVALID' })
  })
})
