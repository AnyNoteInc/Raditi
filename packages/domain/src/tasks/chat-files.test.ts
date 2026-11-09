import { describe, expect, it } from 'vitest'

import { chatFileKey, outboxFileNameSchema, outboxLimits } from './chat-files.ts'
import { feedRowSchema } from './client-feed.ts'

const ok = (name: string) => outboxFileNameSchema.safeParse(name).success

describe('files of the agent for the client', () => {
  it('keeps the limits of the plan', () => {
    expect(outboxLimits).toEqual({
      files: 10,
      fileBytes: 20 * 1024 * 1024,
      archiveBytes: 16 * 1024 * 1024,
      nameChars: 200,
      nameBytes: 100,
    })
  })

  it('takes a name without folders that fits a ustar header', () => {
    expect(ok('Отчёт за ноябрь.docx')).toBe(true)
    expect(ok('report (1).xlsx')).toBe(true)
    expect(ok('a'.repeat(100))).toBe(true)
    expect(ok('a'.repeat(101))).toBe(false)
    expect(ok('я'.repeat(51))).toBe(false)
    for (const name of ['', '.', '..', 'a/b.txt', 'a\\b.txt', 'a\nb', 'a\u0000b', ' a', 'a ', '�'])
      expect(ok(name), JSON.stringify(name)).toBe(false)
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
})
