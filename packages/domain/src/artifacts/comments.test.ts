import { describe, expect, it } from 'vitest'

import {
  artifactCommentAnchorInputSchema,
  artifactCommentAnchorSchema,
  artifactCommentSnapshotSchema,
  commentCellText,
  commentCellTextChars,
} from './comments.ts'

// What a private note anchors to (docs/plan/88-artifacts.md, Ар53, 88.18а, 88.18д).

const cell = { kind: 'cell', block: 'r1', column: 'name', rev: 2 } as const

describe('the anchors of notes', () => {
  it('takes a cell from the cabinet without the words the server reads for it', () => {
    expect(artifactCommentAnchorInputSchema.safeParse(cell).success).toBe(true)
    expect(
      artifactCommentAnchorInputSchema.safeParse({ ...cell, columnName: 'Товар', text: 'Хлеб' })
        .success,
    ).toBe(false)
  })

  it('stores a cell with its column name and text, and a quote as before', () => {
    expect(
      artifactCommentAnchorSchema.parse({ ...cell, columnName: 'Товар', text: 'Хлеб' }),
    ).toEqual({ ...cell, columnName: 'Товар', text: 'Хлеб' })
    expect(artifactCommentAnchorSchema.safeParse(cell).success).toBe(false)
    expect(
      artifactCommentAnchorSchema.parse({
        kind: 'quote',
        block: 's1',
        rev: 1,
        quote: ' хлеб\n и ',
      }),
    ).toMatchObject({ quote: 'хлеб и' })
  })

  it('takes an element of its own block, and stores it with its tag and text (88.18е)', () => {
    const element = { kind: 'element', block: 'hero', element: 'hero.2', rev: 1 } as const
    expect(artifactCommentAnchorInputSchema.safeParse(element).success).toBe(true)
    expect(
      artifactCommentAnchorInputSchema.safeParse({ ...element, element: 'other.2' }).success,
    ).toBe(false)
    expect(
      artifactCommentAnchorInputSchema.safeParse({ ...element, element: 'hero.0' }).success,
    ).toBe(false)
    expect(
      artifactCommentAnchorSchema.parse({ ...element, tag: 'h2', text: 'Цены' }),
    ).toMatchObject({ kind: 'element', tag: 'h2' })
  })

  it('keeps a cell text on one line, at most 200 characters, never half a pair', () => {
    expect(commentCellText(' Хлеб\n\tржаной ')).toBe('Хлеб ржаной')
    const long = commentCellText('😀'.repeat(300))
    expect(Array.from(long)).toHaveLength(commentCellTextChars)
    expect(long.isWellFormed()).toBe(true)
  })

  it('reads a snapshot of both kinds of notes', () => {
    const notes = [
      {
        id: crypto.randomUUID(),
        anchor: { kind: 'quote', block: 's1', rev: 1, quote: 'цены' },
        body: 'а',
        replies: [],
      },
      {
        id: crypto.randomUUID(),
        anchor: { ...cell, columnName: 'Товар', text: '' },
        body: 'б',
        replies: ['в'],
      },
    ]
    expect(artifactCommentSnapshotSchema.safeParse(notes).success).toBe(true)
  })
})
