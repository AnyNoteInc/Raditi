import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DocumentMarkdown } from './document-markdown.ts'

const rules = {
  documents: new Set(['02-цены.md', 'Сводка.html']),
  imageSrc: (name: string) => (name === 'схема.png' ? '/api/tasks/t/files/f/image' : null),
}

/** What the tab draws, as HTML. */
const drawn = (text: string) =>
  renderToStaticMarkup(createElement(DocumentMarkdown, { text, ...rules }))

const HARMFUL = [
  '<script>alert(1)</script>',
  '<img src=x onerror="alert(1)">',
  '[a](javascript:alert(1))',
  '[a](JAVASCRIPT:alert(1))',
  '[a](data:text/html,<script>alert(1)</script>)',
  '[a](//evil.example/x)',
  '![x](https://evil.example/track.png)',
  '![x](//evil.example/t.png)',
  '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
  '![x](a.svg)',
  '<iframe src="https://evil.example"></iframe>',
  '<a href="https://evil.example" style="position:fixed">x</a>',
  '<div id="location" class="x">clobber</div>',
  '<form action="https://evil.example"><input name=p></form>',
  '```js onload=alert(1)\ncode\n```',
  '[x]: javascript:alert(1)\n\n[link][x]',
].join('\n\n')

describe('the rules of a text document (docs/plan/67-agent-documents.md, Д6)', () => {
  it('lets nothing harmful through', () => {
    {
      const html = drawn(HARMFUL)
      expect(html).not.toMatch(/<script|<iframe|<form|<svg|onerror|onload=|javascript:/i)
      expect(html).not.toMatch(/evil\.example/)
      expect(html).not.toMatch(/data:text|data:image\/svg/)
      expect(html).not.toMatch(/style=|class=/)
      expect(html).not.toMatch(/id="(?!doc-)/)
    }
  })

  it('keeps headings with prefixed anchors, safe links and pictures of the chat', () => {
    const text = [
      '# Цены и оплата',
      '## Способы оплаты',
      '[Наверх](#цены-и-оплата) [Цены](02-цены.md#раздел) [Сайт](https://example.com/x) [Почта](mailto:a@b.ru)',
      '![Схема](схема.png) ![Нет](нет.png)',
      '- [x] сделано',
      '| a | b |\n| - | - |\n| 1 | 2 |',
    ].join('\n\n')
    {
      const html = drawn(text)
      expect(html).toContain('<h1 id="doc-цены-и-оплата">')
      expect(html).toContain('<h2 id="doc-способы-оплаты">')
      expect(html).toContain('href="#doc-цены-и-оплата"')
      expect(html).toContain(
        'href="https://example.com/x" target="_blank" rel="noopener noreferrer nofollow"',
      )
      expect(html).toContain('(example.com)')
      expect(html).toContain('href="mailto:a@b.ru"')
      expect(html).toContain('src="/api/tasks/t/files/f/image"')
      expect(html).toContain('<span data-image-missing="">Нет</span>')
      expect(html).toContain('type="checkbox"')
      expect(html).toContain('<table>')
    }
    // A link to another document of the chat stays one, inside the tab; one it lacks is words.
    expect(drawn(text)).toContain('data-document="02-цены.md"')
    expect(drawn('[Нет](нет.md)')).toContain(
      '<span data-missing-document="" title="Такого документа в чате нет.">Нет</span>',
    )
  })
})
