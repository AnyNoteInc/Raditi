import { describe, expect, it } from 'vitest'

import { artifactExcerpt } from './artifact-gallery.ts'

describe('the preview of a card in the gallery (Ар50)', () => {
  it('reads Markdown as text: no marks, links by their words, lines joined', () => {
    expect(
      artifactExcerpt(
        '### Цены\n\n- **Стрижка** — 1 990 ₽\n- [Запись](https://example.ru)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
      ),
    ).toBe('Цены Стрижка — 1 990 ₽ Запись a b 1 2')
  })

  it('cuts a long text with an ellipsis, by letters', () => {
    const text = 'ё'.repeat(300)
    const cut = artifactExcerpt(text, 10)
    expect([...cut]).toHaveLength(10)
    expect(cut.endsWith('…')).toBe(true)
  })
})
