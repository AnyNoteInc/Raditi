import { describe, expect, it } from 'vitest'

import {
  chatFileKey,
  OUTBOX_MANIFEST_BYTES,
  outboxFileNameSchema,
  outboxLimits,
  outboxManifestSchema,
} from './chat-files.ts'
import { feedRowSchema } from './client-feed.ts'

const ok = (name: string) => outboxFileNameSchema.safeParse(name).success

describe('files of the agent for the client', () => {
  it('keeps the limits of the plan', () => {
    expect(outboxLimits).toEqual({
      files: 30,
      fileBytes: 20 * 1024 * 1024,
      archiveBytes: 16 * 1024 * 1024,
      nameChars: 200,
    })
  })

  it('takes a name without folders of up to 200 characters, however many bytes they are', () => {
    expect(ok('Отчёт за ноябрь.docx')).toBe(true)
    expect(ok('report (1).xlsx')).toBe(true)
    // The name that was left in the chat of 11.11.2026: 56 characters, 103 bytes.
    expect(ok('Руководящий_состав_правительства_Смоленской_области.docx')).toBe(true)
    expect(ok('я'.repeat(200))).toBe(true)
    expect(ok('я'.repeat(201))).toBe(false)
    for (const name of ['', '.', '..', 'a/b.txt', 'a\\b.txt', 'a\nb', 'a\u0000b', ' a', 'a ', '�'])
      expect(ok(name), JSON.stringify(name)).toBe(false)
  })

  it('takes a manifest of unique names, and no names when the files were refused', () => {
    const manifest = (m: unknown) => outboxManifestSchema.safeParse(m).success
    const base = { v: 1, names: ['a.txt', 'Смета.xlsx'], skipped: 0, refused: false }
    expect(manifest(base)).toBe(true)
    expect(manifest({ ...base, names: [], skipped: 3 })).toBe(true)
    expect(manifest({ ...base, names: [], refused: true })).toBe(true)
    expect(manifest({ ...base, refused: true })).toBe(false)
    expect(manifest({ ...base, names: ['a.txt', 'a.txt'] })).toBe(false)
    expect(manifest({ ...base, names: ['../a.txt'] })).toBe(false)
    expect(manifest({ ...base, names: Array.from({ length: 31 }, (_, i) => `${i}.txt`) })).toBe(
      false,
    )
    expect(manifest({ ...base, skipped: -1 })).toBe(false)
    expect(manifest({ ...base, extra: 1 })).toBe(false)
  })

  it('writes a feed.file row only with a valid name and size', () => {
    const payload = {
      v: 1,
      fileId: '0199a3f2-0000-8000-8000-0000000000f1',
      name: 'Смета.xlsx',
      sizeBytes: 1024,
    }
    const write = (p: unknown) => feedRowSchema.safeParse({ type: 'feed.file', payload: p }).success
    expect(write(payload)).toBe(true)
    expect(write({ ...payload, name: '../Смета.xlsx' })).toBe(false)
    expect(write({ ...payload, sizeBytes: outboxLimits.fileBytes + 1 })).toBe(false)
    expect(write({ ...payload, extra: 1 })).toBe(false)
  })

  it('builds the key of a file from two ids only', () => {
    expect(
      chatFileKey('0199A3F2-0000-7000-8000-000000000001', '0199a3f2-0000-8000-8000-0000000000f1'),
    ).toBe('chat-files/0199a3f2-0000-7000-8000-000000000001/0199a3f2-0000-8000-8000-0000000000f1')
    expect(() => chatFileKey('../x', '0199a3f2-0000-8000-8000-0000000000f1')).toThrow()
  })

  it('holds the longest manifest of the limit in its bytes (docs/plan/67, Д7)', () => {
    const names = Array.from(
      { length: outboxLimits.files },
      (_, i) => `${String(i).padStart(2, '0')}${'я'.repeat(outboxLimits.nameChars - 2)}`,
    )
    const manifest = { v: 1, names, skipped: 1_000_000, refused: false }
    expect(outboxManifestSchema.safeParse(manifest).success).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThan(OUTBOX_MANIFEST_BYTES)
  })
})
