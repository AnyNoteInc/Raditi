import type { Page } from 'playwright-core'
import { describe, expect, it, vi } from 'vitest'

import { withEditableText } from './editable-text.ts'

/** A page whose elements, by reference, have this text (an `<input>` has none). */
function page(texts: Record<string, string>) {
  const read = vi.fn((selector: string) => selector)
  const fake = {
    locator: (selector: string) => ({
      innerText: async () => {
        read(selector)
        const text = texts[selector.replace('aria-ref=', '')]
        if (text === undefined) throw new Error('not found')
        return text
      },
    }),
  } as unknown as Page
  return { fake, read }
}

describe('the text of editable blocks in the agent’s tree', () => {
  it('is written after a textbox that edits its own content, as a quoted value', async () => {
    const { fake, read } = page({ e3: 'Заголовок\n  новости "свежей"', e4: '', f1e2: 'Абзац' })
    const tree = [
      '- generic [ref=e1]:',
      '  - textbox "Добавить заголовок" [ref=e3]',
      '  - textbox "Имя" [ref=e4]',
      '  - textbox "Имя: и фамилия" [active] [ref=e5]: Иван',
      '  - iframe [ref=e6]:',
      '    - textbox [ref=f1e2]',
      '  - textbox "Комментарий" [ref=e7]:',
      '    - paragraph [ref=e8]: уже видно',
    ].join('\n')
    expect((await withEditableText(fake, tree, 1_000)).split('\n')).toEqual([
      '- generic [ref=e1]:',
      '  - textbox "Добавить заголовок" [ref=e3]: "Заголовок новости \\"свежей\\""',
      // An empty input reads as no text: left as Playwright wrote it.
      '  - textbox "Имя" [ref=e4]',
      '  - textbox "Имя: и фамилия" [active] [ref=e5]: Иван',
      '  - iframe [ref=e6]:',
      '    - textbox [ref=f1e2]: "Абзац"',
      '  - textbox "Комментарий" [ref=e7]:',
      '    - paragraph [ref=e8]: уже видно',
    ])
    // Only bare textboxes are read: never one with a value or children.
    expect(read.mock.calls.map(([selector]) => selector)).toEqual([
      'aria-ref=e3',
      'aria-ref=e4',
      'aria-ref=f1e2',
    ])
  })

  it('reads a bounded number of blocks, a bounded text of each', async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `- textbox [ref=e${index + 1}]`)
    const texts = Object.fromEntries(
      lines.map((_, index) => [`e${index + 1}`, 'слово '.repeat(1000)]),
    )
    const { fake, read } = page(texts)
    const written = (await withEditableText(fake, lines.join('\n'), 1_000)).split('\n')
    expect(read).toHaveBeenCalledTimes(32)
    expect(written[0]?.length).toBeLessThan(2_100)
    expect(written[39]).toBe('- textbox [ref=e40]')
  })
})
