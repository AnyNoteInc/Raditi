import { describe, expect, it } from 'vitest'

import {
  chatDocumentsOf,
  chatImageAt,
  documentImageOf,
  documentKindOf,
  documentLinkOf,
  documentSlug,
  openingDocumentOf,
  requestedFileFormats,
  type ChatFileRow,
} from './chat-documents.ts'

const file = (id: string, name: string, fileId = `f-${id}`): ChatFileRow => ({
  id,
  type: 'feed.file',
  fileId,
  name,
  sizeBytes: 10,
})

describe('documentKindOf', () => {
  it('tells a page and a text document by the extension, in any case', () => {
    expect(documentKindOf('Отчёт.html')).toBe('page')
    expect(documentKindOf('a.HTM')).toBe('page')
    expect(documentKindOf('Статья.md')).toBe('markdown')
    expect(documentKindOf('b.Markdown')).toBe('markdown')
    for (const name of ['a.docx', 'b.xlsx', 'c.png', 'md', 'html', 'x.html.zip'])
      expect(documentKindOf(name)).toBeNull()
  })
})

describe('chatDocumentsOf', () => {
  it('groups the versions of one name, sorts names naturally and marks the fresh ones', () => {
    const rows: ChatFileRow[] = [
      { id: '1', type: 'feed.request' },
      file('2', '10-итог.md'),
      file('3', '02-цены.md'),
      file('4', 'отчёт.docx'),
      { id: '5', type: 'feed.request' },
      file('6', '02-цены.md'),
      file('7', 'Сводка.html'),
    ]
    const documents = chatDocumentsOf(rows)
    expect(documents.map((d) => d.name)).toEqual(['02-цены.md', '10-итог.md', 'Сводка.html'])
    expect(documents[0]!.versions.map((v) => v.fileId)).toEqual(['f-3', 'f-6'])
    expect(documents.map((d) => d.fresh)).toEqual([true, false, true])
    expect(documents[2]).toMatchObject({ kind: 'page', title: 'Сводка' })
  })

  it('reads rows in the order of their ids, whatever order they come in', () => {
    const documents = chatDocumentsOf([file('10', 'a.md', 'second'), file('9', 'a.md', 'first')])
    expect(documents[0]!.versions.map((v) => v.fileId)).toEqual(['first', 'second'])
  })
})

describe('openingDocumentOf', () => {
  it('opens the table of contents of a set, else the first by name', () => {
    expect(openingDocumentOf(['02-b.md', '00-оглавление.md', '01-a.md'])).toBe('00-оглавление.md')
    expect(openingDocumentOf(['b.md', 'README.md'])).toBe('README.md')
    expect(openingDocumentOf(['б.md', 'Оглавление.md'])).toBe('Оглавление.md')
    expect(openingDocumentOf(['10-a.md', '2-b.md'])).toBe('2-b.md')
    expect(openingDocumentOf([])).toBeNull()
  })
})

describe('chatImageAt', () => {
  it('takes the picture as it was when the version of the document came', () => {
    const rows = [file('1', 'схема.png', 'old'), file('2', 'doc.md'), file('3', 'схема.png', 'new')]
    expect(chatImageAt(rows, 'схема.png', '2')?.fileId).toBe('old')
    expect(chatImageAt(rows, 'схема.png', '3')?.fileId).toBe('new')
    expect(chatImageAt(rows, 'нет.png', '3')).toBeNull()
  })

  it('never names SVG or a file that is no picture', () => {
    const rows = [file('1', 'a.svg'), file('2', 'b.docx')]
    expect(chatImageAt(rows, 'a.svg', '9')).toBeNull()
    expect(chatImageAt(rows, 'b.docx', '9')).toBeNull()
  })
})

describe('documentLinkOf', () => {
  const documents = new Set(['02-цены.md', 'Сводка.html'])
  it('keeps external, anchor and document links', () => {
    expect(documentLinkOf('https://example.com/a', documents)).toEqual({
      kind: 'external',
      href: 'https://example.com/a',
    })
    expect(documentLinkOf('mailto:a@b.ru', documents).kind).toBe('external')
    expect(documentLinkOf('#способы', documents)).toEqual({ kind: 'anchor', anchor: 'способы' })
    expect(documentLinkOf('02-цены.md#раздел', documents)).toEqual({
      kind: 'document',
      name: '02-цены.md',
      anchor: 'раздел',
    })
    expect(documentLinkOf('./%D0%A1%D0%B2%D0%BE%D0%B4%D0%BA%D0%B0.html', documents)).toEqual({
      kind: 'document',
      name: 'Сводка.html',
      anchor: null,
    })
  })

  it('makes no link of anything else', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '//evil.example/x',
      'vbscript:x',
      '../etc/passwd',
      'folder/02-цены.md',
      'нет.md',
      '%E0%A4%A',
      '',
      '#',
    ])
      expect(documentLinkOf(href, documents)).toEqual({ kind: 'none' })
  })
})

describe('documentImageOf', () => {
  it('shows a picture of the chat by its name and a data image of four kinds', () => {
    expect(documentImageOf('scheme.png')).toEqual({ kind: 'chat', name: 'scheme.png' })
    expect(documentImageOf('./схема.JPG')).toEqual({ kind: 'chat', name: 'схема.JPG' })
    expect(documentImageOf('data:image/png;base64,iVBO R=')).toEqual({
      kind: 'data',
      src: 'data:image/png;base64,iVBOR=',
    })
  })

  it('never loads another site, a folder or SVG', () => {
    for (const src of [
      'https://evil.example/a.png',
      '//evil.example/a.png',
      'img/a.png',
      'a.svg',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:text/html;base64,PHNjcmlwdD4=',
      'javascript:alert(1)',
      'a.png?x=1',
    ])
      expect(documentImageOf(src)).toBeNull()
  })
})

describe('documentSlug', () => {
  it('keeps Cyrillic and numbers repeated headings', () => {
    const seen = new Map<string, number>()
    expect(documentSlug('Способы оплаты!', seen)).toBe('способы-оплаты')
    expect(documentSlug('Способы оплаты', seen)).toBe('способы-оплаты-1')
    expect(documentSlug('<script>', seen)).toBe('script')
    expect(documentSlug('!!!', seen)).toBe('section')
  })
})

describe('requestedFileFormats', () => {
  it('hears Word in its Russian forms', () => {
    for (const text of [
      'Сделайте отчёт в Word',
      'нужен вордовский файл',
      'пришлите в ворде',
      'файл docx, пожалуйста',
      'Сохраните как .doc',
    ])
      expect(requestedFileFormats(text)).toMatchObject({ word: true })
  })

  it('hears Excel and Markdown', () => {
    expect(requestedFileFormats('таблицу в экселе').excel).toBe(true)
    expect(requestedFileFormats('выгрузите в Excel').excel).toBe(true)
    expect(requestedFileFormats('файл xlsx').excel).toBe(true)
    expect(requestedFileFormats('напишите в маркдауне').markdown).toBe(true)
    expect(requestedFileFormats('в формате md').markdown).toBe(true)
    expect(requestedFileFormats('Markdown, пожалуйста').markdown).toBe(true)
  })

  it('does not hear them inside other words or when the client says no', () => {
    expect(requestedFileFormats('Подготовьте отчёт о продажах')).toEqual({
      word: false,
      excel: false,
      markdown: false,
    })
    for (const text of [
      'пароль wordpress',
      'страница wordpress.org',
      'не в ворде, просто страницу',
      'без ворда',
      'не нужен Excel',
      'command md5',
      'отзывы клиентов',
    ]) {
      const formats = requestedFileFormats(text)
      expect([formats.word, formats.excel, formats.markdown]).toEqual([false, false, false])
    }
  })
})
