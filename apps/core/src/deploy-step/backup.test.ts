import { createHash } from 'node:crypto'

import {
  deployBackupAad,
  publishedContentHashMaterial,
  type PublishedContentState,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { openBackup, packBackup, sealBackup, unpackBackup } from './backup.ts'
import { deployKeyOf, openDeployEnvelope, sealDeployEnvelope } from './envelope.ts'

const releaseId = '0196abcd-0000-7000-8000-00000000000a'
const key = Buffer.alloc(32, 7)
const otherKey = Buffer.alloc(32, 8)

function record(id: number, title: string): PublishedContentState {
  const state = {
    version: 1 as const,
    objectRef: `page:${id}`,
    kind: 'page' as const,
    title,
    content: '<p>Текст страницы</p>',
    excerpt: '',
  }
  return {
    ...state,
    stateHash: createHash('sha256').update(publishedContentHashMaterial(state)).digest('hex'),
  }
}

const contents = {
  releaseId,
  deployAttempt: 2,
  files: [
    { path: 'wp-content/themes/shop/style.css', bytes: Buffer.from('body{}\n'), mode: 0o644 },
    { path: 'wp-content/themes/shop/функции.php', bytes: Buffer.from('<?php\n'), mode: null },
    { path: 'empty.txt', bytes: Buffer.alloc(0), mode: 0o600 },
  ],
  records: [record(42, 'Главная'), record(7, 'Контакты')],
  folders: ['wp-content/plugins/new', 'wp-content/plugins/new/assets'],
}

describe('the envelope of an attempt', () => {
  it('opens with the key and the associated data it was sealed with, nothing else', () => {
    const sealed = sealDeployEnvelope(Buffer.from('секрет'), key, 'aad-1')
    expect(sealed.subarray(0, 4).toString('latin1')).toBe('RDE1')
    expect(sealed.byteLength).toBe(4 + 12 + 16 + Buffer.byteLength('секрет'))
    expect(openDeployEnvelope(sealed, key, 'aad-1').toString()).toBe('секрет')
    // A fresh IV every time: the same plaintext never seals to the same bytes.
    expect(sealDeployEnvelope(Buffer.from('секрет'), key, 'aad-1').equals(sealed)).toBe(false)
    const changed = Buffer.from(sealed)
    changed[changed.length - 1]! ^= 1
    for (const [bytes, withKey, aad] of [
      [sealed, otherKey, 'aad-1'],
      [sealed, key, 'aad-2'],
      [changed, key, 'aad-1'],
      [sealed.subarray(4), key, 'aad-1'],
      [Buffer.alloc(10), key, 'aad-1'],
      [sealed, Buffer.alloc(16), 'aad-1'],
    ] as const)
      expect(() => openDeployEnvelope(bytes, withKey, aad)).toThrow(
        'Deploy envelope authentication failed',
      )
  })

  it('takes a key of exactly 32 bytes of canonical base64', () => {
    expect(deployKeyOf(key.toString('base64')).equals(key)).toBe(true)
    for (const text of [
      Buffer.alloc(16).toString('base64'),
      'not base64',
      `${key.toString('base64')}A`,
    ])
      expect(() => deployKeyOf(text)).toThrow(/32 bytes/)
  })
})

describe('the backup of an attempt (Р30)', () => {
  it('packs the overwritten files and the prior records and reads them back', async () => {
    const archive = await packBackup(contents)
    const back = await unpackBackup(archive)
    expect(back.releaseId).toBe(releaseId)
    expect(back.deployAttempt).toBe(2)
    expect(
      back.files.map((file) => [file.path, Buffer.from(file.bytes).toString(), file.mode]),
    ).toEqual([
      ['wp-content/themes/shop/style.css', 'body{}\n', 0o644],
      ['wp-content/themes/shop/функции.php', '<?php\n', null],
      ['empty.txt', '', 0o600],
    ])
    expect(back.records).toEqual(contents.records)
    expect(back.folders).toEqual(contents.folders)
    // No time and no owner in it: the same contents pack to the same bytes.
    expect((await packBackup(contents)).equals(archive)).toBe(true)
  })

  it('seals the archive for its release and attempt only', async () => {
    const { sealed, sha256, sizeBytes } = await sealBackup(contents, key)
    expect(sizeBytes).toBe(sealed.byteLength)
    expect(sha256).toBe(createHash('sha256').update(sealed).digest('hex'))
    const back = await openBackup(sealed, key, releaseId, 2)
    expect(back.files).toHaveLength(3)
    await expect(openBackup(sealed, key, releaseId, 3)).rejects.toThrow()
    await expect(
      openBackup(sealed, key, '0196abcd-0000-7000-8000-00000000000b', 2),
    ).rejects.toThrow()
    await expect(openBackup(sealed, otherKey, releaseId, 2)).rejects.toThrow()
  })

  it('refuses an archive whose entries do not agree with its index', async () => {
    const archive = await packBackup(contents)
    // Another attempt's index inside this attempt's envelope.
    const foreign = await packBackup({ ...contents, deployAttempt: 3 })
    const sealedForeign = sealDeployEnvelope(foreign, key, deployBackupAad(releaseId, 2))
    await expect(openBackup(sealedForeign, key, releaseId, 2)).rejects.toThrow(
      'Invalid deploy backup',
    )
    // Bytes that are not a zstd archive.
    await expect(unpackBackup(Buffer.from('not an archive'))).rejects.toThrow(
      'Invalid deploy backup',
    )
    expect(archive.byteLength).toBeGreaterThan(0)
  })

  it('names no path of the site in the archive', async () => {
    const archive = await packBackup(contents)
    const { createZstdDecompress } = await import('node:zlib')
    const { Readable } = await import('node:stream')
    const chunks: Buffer[] = []
    for await (const chunk of Readable.from([archive]).pipe(createZstdDecompress()))
      chunks.push(chunk as Buffer)
    const tar = Buffer.concat(chunks)
    const names: string[] = []
    for (let offset = 0; offset + 512 <= tar.length;) {
      const name = tar.toString('utf8', offset, offset + 100).replace(/\0.*$/s, '')
      if (name === '') break
      names.push(name)
      const size = parseInt(tar.toString('latin1', offset + 124, offset + 136).trim() || '0', 8)
      offset += 512 + Math.ceil(size / 512) * 512
    }
    expect(names).toEqual([
      'backup.json',
      'files/0',
      'files/1',
      'files/2',
      'records/0.json',
      'records/1.json',
    ])
  })
})
