import { describe, expect, it } from 'vitest'

import { editPageText } from './edit.ts'

describe('editPageText', () => {
  it('replaces what is found once, every time with all, in order', () => {
    expect(editPageText('a b a', [{ old: 'b', new: 'c' }])).toEqual({ ok: true, text: 'a c a' })
    expect(editPageText('a b a', [{ old: 'a', new: 'x', all: true }])).toEqual({
      ok: true,
      text: 'x b x',
    })
    // The second edit sees the text of the first.
    expect(
      editPageText('цена 100', [
        { old: '100', new: '200' },
        { old: 'цена 200', new: 'цена 300' },
      ]),
    ).toEqual({ ok: true, text: 'цена 300' })
  })

  it('names the first edit that cannot be made, and how many times it was found', () => {
    expect(editPageText('a b a', [{ old: 'a', new: 'x' }])).toEqual({ ok: false, at: 0, found: 2 })
    expect(
      editPageText('a b', [
        { old: 'b', new: 'c' },
        { old: 'z', new: 'x' },
      ]),
    ).toEqual({ ok: false, at: 1, found: 0 })
  })
})
