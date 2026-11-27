import type { QuickEditBlock } from '@repo/db'
import type { ArtifactCommentSnapshot } from '@repo/domain/artifacts'
import { describe, expect, it } from 'vitest'

import { canvasParts, documentParts } from './quick-edit-parts.ts'

// The parts of a quick edit and the way back into blocks (docs/plan/98-quick-edits.md, stage 4).

const html =
  '<section class="hero">\n  <h1>Кофе с собой</h1>\n  <p>Работаем с <b>8:00</b> до 20:00</p>\n</section>'
const block = (key: string, markdown: string): QuickEditBlock => ({
  key,
  heading: null,
  markdown,
  rev: 4,
  hold: null,
})
const byKey = new Map([['hero', block('hero', html)]])

type Note = ArtifactCommentSnapshot[number]
const elementNote = (
  id: string,
  element: string,
  tag: string,
  body = 'Поправьте',
  text?: string,
): Note =>
  ({
    id,
    anchor: {
      kind: 'element',
      block: 'hero',
      element,
      rev: 4,
      tag,
      ...(text === undefined ? {} : { text }),
    },
    body,
    replies: [],
  }) as unknown as Note

const N1 = '019f1a21-1800-7f00-8abc-0000000000a1'
const N2 = '019f1a21-1800-7f00-8abc-0000000000a2'

describe('the parts of a canvas', () => {
  it('shows the source of each element under an alias, with the note on it', () => {
    const prepared = canvasParts([elementNote(N1, 'hero.2', 'h1')], byKey)
    if (typeof prepared === 'string') throw new Error(prepared)
    expect(prepared.parts).toEqual([
      { key: 'e1', heading: null, markdown: '<h1>Кофе с собой</h1>', tag: 'h1' },
    ])
    expect(prepared.notes[0]).toMatchObject({ id: N1, part: 'e1', p: 1, by: 'client' })
  })

  it('reads an element inside another chosen one as the outer one', () => {
    const prepared = canvasParts(
      [elementNote(N1, 'hero.3', 'p'), elementNote(N2, 'hero.4', 'b')],
      byKey,
    )
    if (typeof prepared === 'string') throw new Error(prepared)
    expect(prepared.parts.map((part) => part.tag)).toEqual(['p'])
    expect(prepared.notes.map((note) => note.part)).toEqual(['e1', 'e1'])
  })

  it('takes a gone element, another tag or another text for a moved place', () => {
    expect(canvasParts([elementNote(N1, 'hero.9', 'h1')], byKey)).toBe('moved')
    expect(canvasParts([elementNote(N1, 'hero.2', 'h2')], byKey)).toBe('moved')
    // The id now names another heading: the client saw «Цена 100 ₽» there.
    expect(canvasParts([elementNote(N1, 'hero.2', 'h1', 'x', 'Цена 100 ₽')], byKey)).toBe('moved')
    const same = canvasParts([elementNote(N1, 'hero.2', 'h1', 'x', 'Кофе с собой')], byKey)
    expect(typeof same).toBe('object')
  })

  it('refuses an address the client did not give, and lets one they gave in', () => {
    const asked = canvasParts(
      [elementNote(N1, 'hero.2', 'h1', 'Сделайте ссылкой на shop.ru/menu')],
      byKey,
    )
    if (typeof asked === 'string') throw new Error(asked)
    expect(
      asked.apply([
        { part: 'e1', p: 1, to: '<h1><a href="https://shop.ru/menu">Кофе с собой</a></h1>' },
      ]),
    ).toMatchObject({ ok: true })
    expect(
      asked.apply([{ part: 'e1', p: 1, to: '<h1><a href="https://evil.example">Кофе</a></h1>' }]),
    ).toMatchObject({ ok: false, reason: 'links' })
  })

  it('puts the edit back into the block, the rest byte for byte', () => {
    const prepared = canvasParts([elementNote(N1, 'hero.2', 'h1')], byKey)
    if (typeof prepared === 'string') throw new Error(prepared)
    expect(prepared.apply([{ part: 'e1', p: 1, find: 'с собой', to: 'навынос' }])).toEqual({
      ok: true,
      blocks: new Map([['hero', html.replace('Кофе с собой', 'Кофе навынос')]]),
    })
  })

  it('refuses an edit that adds a handler, and asks again for one that is not one element', () => {
    const prepared = canvasParts([elementNote(N1, 'hero.2', 'h1')], byKey)
    if (typeof prepared === 'string') throw new Error(prepared)
    const script = prepared.apply([{ part: 'e1', p: 1, to: '<h1 onclick="steal()">Кофе</h1>' }])
    expect(script).toMatchObject({ ok: false, reason: 'check' })
    const two = prepared.apply([{ part: 'e1', p: 1, to: '<h1>Кофе</h1><p>ещё</p>' }])
    expect(two).toMatchObject({ ok: false })
    expect(two.ok === false && two.reason).toBeFalsy()
  })

  it('ends with «stale» when the block changed after it was read', () => {
    const prepared = canvasParts([elementNote(N1, 'hero.2', 'h1')], byKey)
    if (typeof prepared === 'string') throw new Error(prepared)
    byKey.set('hero', block('hero', html.replace('Кофе с собой', 'Чай')))
    try {
      expect(prepared.apply([{ part: 'e1', p: 1, find: 'с собой', to: 'навынос' }])).toMatchObject({
        ok: false,
        reason: 'stale',
      })
    } finally {
      byKey.set('hero', block('hero', html))
    }
  })
})

describe('the parts of a document', () => {
  it('refuses an element anchor: a document has quotes', () => {
    expect(
      documentParts([elementNote(N1, 'hero.2', 'h1')], new Map([['hero', block('hero', 'Текст')]])),
    ).toBe('moved')
  })
})
