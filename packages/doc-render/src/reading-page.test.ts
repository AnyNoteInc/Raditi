import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DocumentMarkdown } from './document-markdown.ts'
import { READING_PAGE_CSS, readingPage } from './reading-page.ts'

const MARKDOWN = [
  '# Аудит <сайта>',
  '',
  '## Цены',
  '',
  'См. [раздел](#цены), [прайс](02-цены.md) и [сайт](https://example.ru/price).',
  '',
  '![схема](схема.png) ![точка](data:image/png;base64,iVBORw0KGgo=)',
  '',
  '<script>alert(1)</script>',
  '',
  '| Услуга | Цена |',
  '| --- | ---: |',
  '| Правка | 50 ₽ |',
].join('\n')

describe('the page for reading (docs/plan/69-pages.md, Ст11)', () => {
  it('is the tree of the tab, standing alone, in its own style', async () => {
    const html = await readingPage({ title: 'Аудит <сайта>', markdown: MARKDOWN })
    const body = renderToStaticMarkup(
      createElement(DocumentMarkdown, {
        text: MARKDOWN,
        documents: new Set<string>(),
        imageSrc: () => null,
        documentLinks: false,
      }),
    )
    expect(html).toBe(
      '<!doctype html><html lang="ru"><head><meta charSet="utf-8"/>' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
        '<meta name="robots" content="noindex, nofollow"/><title>Аудит &lt;сайта&gt;</title>' +
        `<style>${READING_PAGE_CSS}</style></head><body><main><article>${body}</article></main></body></html>`,
    )
  })

  it('draws what a document holds and nothing it should not', async () => {
    const html = await readingPage({ title: 'Аудит', markdown: MARKDOWN })
    expect(html).toContain('<h1 id="doc-аудит-сайта">')
    expect(html).toContain('<h2 id="doc-цены">Цены</h2>')
    expect(html).toContain('<a href="#doc-цены">раздел</a>')
    // A document of the chat is its words here, a picture of the chat by name — its words too.
    expect(html).toContain('<span>прайс</span>')
    expect(html).toContain('<span data-image-missing="">схема</span>')
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="')
    expect(html).toContain(
      '<a href="https://example.ru/price" target="_blank" rel="noopener noreferrer nofollow">сайт<span data-host=""> (example.ru)</span></a>',
    )
    // The alignment of a column is the one style react-markdown writes itself, from `align`.
    expect(html).toContain('<td style="text-align:right">50 ₽</td>')
    expect(html.slice(html.indexOf('<body>'))).not.toContain('data-missing-document')
    expect(html).not.toMatch(/<script|alert/)
  })

  it('loads nothing: no address in its style', () => {
    expect(READING_PAGE_CSS).not.toMatch(/url\(|@import|https?:/)
  })
})
