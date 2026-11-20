import { describe, expect, it } from 'vitest'

import { mergeThree, wordDiff } from './merge'

const base = ['Привозим с 8 до 21.', 'Заказ от 2 000 ₽ — бесплатно.', 'Звоним за полчаса.'].join(
  '\n',
)

describe('the three-way merge of a section (Ар18)', () => {
  it('keeps the changes of different lines from both', () => {
    const mine = base.replace('с 8', 'с 9')
    const theirs = base.replace('за полчаса', 'за час')
    expect(mergeThree(base, mine, theirs)).toEqual({
      clean: true,
      text: ['Привозим с 9 до 21.', 'Заказ от 2 000 ₽ — бесплатно.', 'Звоним за час.'].join('\n'),
    })
  })

  it('keeps a line both added at the end once when it is the same', () => {
    const mine = `${base}\nСамовывоз — с 7 утра.`
    expect(mergeThree(base, mine, mine)).toEqual({ clean: true, text: mine })
  })

  it('takes the only side that changed', () => {
    const theirs = base.replace('2 000', '1 500')
    expect(mergeThree(base, base, theirs)).toEqual({ clean: true, text: theirs })
  })

  it('diverges when both changed one line differently', () => {
    expect(
      mergeThree(
        base,
        base.replace('с 8', 'с 9'),
        base.replace('2 000', '1 500').replace('с 8', 'с 7'),
      ),
    ).toEqual({
      clean: false,
    })
  })

  it('diverges when both added different lines at one place', () => {
    expect(mergeThree(base, `${base}\nА`, `${base}\nБ`)).toEqual({ clean: false })
  })
})

describe('the comparison by words (D-conflict)', () => {
  it('names what was taken away and added', () => {
    expect(wordDiff('с 8 до 21 часа', 'с 9 до 21 часа')).toEqual([
      { kind: 'same', text: 'с' },
      { kind: 'removed', text: ' 8' },
      { kind: 'added', text: ' 9' },
      { kind: 'same', text: ' до 21 часа' },
    ])
  })
})
