import { describe, expect, it, vi } from 'vitest'

import { contentObjectRefSchema } from './content-snapshots.ts'
import { restoreArgumentsSchema, wpRestArgumentsSchema } from './mcp-content.ts'
import { mcpCanonicalJson, mcpIdempotencyKeySchema, PostgresMcpJournal } from './mcp-journal.ts'

describe('MCP journal input boundaries', () => {
  it('canonicalises object order, preserving array order and literal values', () => {
    expect(mcpCanonicalJson({ b: [2, 1], a: { y: true, x: 'привет' } })).toBe(
      '{"a":{"x":"привет","y":true},"b":[2,1]}',
    )
  })

  it.each([
    undefined,
    Number.NaN,
    new Date(),
    JSON.parse('{"__proto__":1}') as unknown,
    Array(5001).fill(0),
    { private: 'x'.repeat(65536) },
    JSON.parse(`${'{"x":'.repeat(17)}0${'}'.repeat(17)}`) as unknown,
  ])('rejects invalid or unbounded JSON without reflecting values', (input) => {
    expect(() => mcpCanonicalJson(input)).toThrow(
      /Invalid MCP journal JSON|MCP journal JSON exceeds its limit/,
    )
  })

  // A key or an object reference is one line that may reach an operator's terminal or a log.
  const controls = [
    ['a tab', 'a\tb'],
    ['a line feed', 'a\nb'],
    ['DEL', 'a\u007fb'],
    ['NEL, a C1 line break', 'a\u0085b'],
    ['CSI, the 8-bit start of an escape sequence', 'a\u009bb'],
    ['a NUL', 'a\0b'],
  ] as const

  it.each(controls)(
    'refuses %s in an idempotency key and in an object reference',
    (_name, text) => {
      expect(mcpIdempotencyKeySchema.safeParse(text).success).toBe(false)
      expect(contentObjectRefSchema.safeParse(text).success).toBe(false)
      // The tools take the very same key rule: there is no second copy to fall behind.
      expect(
        wpRestArgumentsSchema.safeParse({
          method: 'POST',
          route: '/wp/v2/pages/42',
          body: { title: 'Заголовок' },
          idempotencyKey: text,
        }).success,
      ).toBe(false)
      expect(
        restoreArgumentsSchema.safeParse({
          snapshotId: '01960000-0000-7000-8000-000000000009',
          idempotencyKey: text,
        }).success,
      ).toBe(false)
    },
  )

  it('takes ordinary one-line text, Cyrillic and emoji included', () => {
    for (const text of ['edit-1', 'правка № 2 — «заголовок»', 'undo:3:🪴', 'a\u00a0b'])
      expect(mcpIdempotencyKeySchema.safeParse(text).success).toBe(true)
    for (const text of ['post:42', 'page:7', 'option:blogname'])
      expect(contentObjectRefSchema.safeParse(text).success).toBe(true)
    expect(mcpIdempotencyKeySchema.safeParse('').success).toBe(false)
    expect(mcpIdempotencyKeySchema.safeParse('k'.repeat(201)).success).toBe(false)
  })

  it.each(controls)(
    'refuses a journal command with %s before any transaction',
    async (_n, text) => {
      const db = { $transaction: vi.fn() }
      const scope = {
        keyId: '01960000-0000-7000-8000-000000000001',
        taskId: '01960000-0000-7000-8000-000000000002',
        workspaceId: '01960000-0000-7000-8000-000000000003',
        siteId: '01960000-0000-7000-8000-000000000004',
        sessionId: 'session',
        turn: 1,
        firstEpoch: 1,
        epoch: 1,
        stack: 'wordpress' as const,
        url: 'https://site.example.test/',
      }
      const command = {
        tool: 'wp_rest',
        objectRef: 'post:42',
        idempotencyKey: 'key',
        arguments: {},
      }
      for (const broken of [{ idempotencyKey: text }, { objectRef: text }])
        await expect(
          new PostgresMcpJournal(db).reserve(scope, { ...command, ...broken }),
        ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid MCP mutation command' })
      expect(db.$transaction).not.toHaveBeenCalled()
    },
  )

  it('rejects a forged scope without opening a database transaction', async () => {
    const db = { $transaction: vi.fn() }
    const journal = new PostgresMcpJournal(db)
    await expect(
      journal.reserve({} as never, {
        tool: 'wp_rest',
        objectRef: 'post:42',
        idempotencyKey: 'synthetic',
        arguments: {},
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid MCP journal scope' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})
