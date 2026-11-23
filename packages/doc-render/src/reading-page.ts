import { createElement } from 'react'

import { DocumentMarkdown } from './document-markdown.ts'

// The page for reading (docs/plan/69-pages.md, Ст11): a text document drawn once into HTML by the
// very tree and rules of the cabinet's tab, dressed in Raditi's own style, nothing loaded from
// anywhere. It is served under PAGE_READING_CSP — no script at all — so it carries none. The server
// renderer is imported when a page is drawn: Next refuses a static import of react-dom/server in
// its server graph, which reaches this package through @repo/trpc.

/**
 * The style of a page for reading: the paper and ink of the cabinet (`@repo/ui` tokens), the fonts
 * of the system, a column for reading, light and dark.
 */
export const READING_PAGE_CSS = `
:root{color-scheme:light dark;--paper:#FFF8EC;--card:#FFFCF5;--ink:#241710;--muted:#695547;--rule:#E1CDB6;--accent:#A63D12;--code:#F3E7D5}
@media (prefers-color-scheme:dark){:root{--paper:#241710;--card:#352217;--ink:#FFF1DE;--muted:#C6AE95;--rule:#5A3C28;--accent:#FFB86B;--code:#352217}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:anywhere}
main{max-width:46rem;margin:0 auto;padding:3rem 1rem 4rem}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:2em 0 .6em;font-weight:650}
h1{font-size:2rem;margin-top:0}
h2{font-size:1.45rem;padding-bottom:.3em;border-bottom:1px solid var(--rule)}
h3{font-size:1.2rem}
p,ul,ol,blockquote,pre,table{margin:0 0 1em}
a{color:var(--accent);text-underline-offset:.15em}
[data-host]{color:var(--muted);font-size:.9em}
[data-missing-document],[data-image-missing]{color:var(--muted);font-style:italic}
img{max-width:100%;height:auto;border-radius:8px}
blockquote{margin-left:0;padding:.2em 1em;border-left:3px solid var(--rule);color:var(--muted)}
code{font:.9em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:.1em .3em;border-radius:4px}
pre{background:var(--code);padding:1em;border-radius:8px;overflow-x:auto}
pre code{background:none;padding:0}
table{border-collapse:collapse;display:block;max-width:100%;overflow-x:auto}
th,td{border:1px solid var(--rule);padding:.4em .7em;text-align:left;vertical-align:top}
th{background:var(--card)}
hr{border:0;border-top:1px solid var(--rule);margin:2em 0}
li>input[type=checkbox]{margin-right:.4em}
`
  .trim()
  .replace(/\n/g, '')

export interface ReadingPageInput {
  /** The title of the page: its `<title>`, as the client named the document. */
  title: string
  /** The Markdown of the document, its own `# …` heading included (`assembleDocMarkdown`). */
  markdown: string
}

/**
 * The HTML of a page for reading. A document stands alone here: a link to another document of the
 * chat becomes its words, a picture of the chat by name becomes its words too — only a `data:`
 * picture inside the text is drawn.
 */
export async function readingPage({ title, markdown }: ReadingPageInput): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const article = createElement(DocumentMarkdown, {
    text: markdown,
    documents: new Set<string>(),
    imageSrc: () => null,
    documentLinks: false,
    // A page for reading is a page of a site of pages: its links from the root stay (Дер20).
    treeLinks: true,
  })
  const html = createElement(
    'html',
    { lang: 'ru' },
    createElement(
      'head',
      null,
      createElement('meta', { charSet: 'utf-8' }),
      createElement('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      createElement('meta', { name: 'robots', content: 'noindex, nofollow' }),
      createElement('title', null, title),
      createElement('style', { dangerouslySetInnerHTML: { __html: READING_PAGE_CSS } }),
    ),
    createElement(
      'body',
      null,
      createElement('main', null, createElement('article', null, article)),
    ),
  )
  return `<!doctype html>${renderToStaticMarkup(html)}`
}

export interface DiagramPageInput {
  title: string
  /** The pictures of «Схема», files of the site (`/_files/a/…`), in the order of their blocks. */
  pictures: readonly { src: string; width: number; height: number }[]
}

/**
 * A published «Схема» (docs/plan/88-artifacts.md, §7.10, 88.24в): the reading page with its title
 * and the SVG the server drew and cleaned, as `<img>` — no script, nothing of Mermaid on the page.
 */
export async function diagramPage({ title, pictures }: DiagramPageInput): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const html = createElement(
    'html',
    { lang: 'ru' },
    createElement(
      'head',
      null,
      createElement('meta', { charSet: 'utf-8' }),
      createElement('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      createElement('meta', { name: 'robots', content: 'noindex, nofollow' }),
      createElement('title', null, title),
      createElement('style', { dangerouslySetInnerHTML: { __html: READING_PAGE_CSS } }),
    ),
    createElement(
      'body',
      null,
      createElement(
        'main',
        null,
        createElement(
          'article',
          null,
          createElement('h1', null, title),
          ...pictures.map((picture, index) =>
            createElement(
              'figure',
              { key: index, style: { margin: '24px 0' } },
              createElement('img', {
                src: picture.src,
                width: picture.width,
                height: picture.height,
                alt: title,
              }),
            ),
          ),
        ),
      ),
    ),
  )
  return `<!doctype html>${renderToStaticMarkup(html)}`
}

export type ReportPagePart =
  | { kind: 'section'; heading: string | null; markdown: string }
  | { kind: 'picture'; src: string; width: number; height: number }
  | { kind: 'table'; head: readonly string[]; rows: readonly (readonly string[])[] }

/**
 * A published «Отчёт» (docs/plan/88-artifacts.md, §7.10, 88.28): the reading page with its title, its
 * sections, its charts — the SVG the server drew, files of the site — and its table. No script.
 */
export async function reportPage(input: {
  title: string
  parts: readonly ReportPagePart[]
}): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const part = (each: ReportPagePart, index: number) =>
    each.kind === 'section'
      ? createElement(
          'section',
          { key: index },
          each.heading ? createElement('h2', null, each.heading) : null,
          createElement(DocumentMarkdown, {
            text: each.markdown,
            documents: new Set<string>(),
            imageSrc: () => null,
            documentLinks: false,
            treeLinks: true,
          }),
        )
      : each.kind === 'picture'
        ? createElement(
            'figure',
            { key: index, style: { margin: '24px 0' } },
            createElement('img', {
              src: each.src,
              width: each.width,
              height: each.height,
              alt: '',
            }),
          )
        : createElement(
            'table',
            { key: index },
            createElement(
              'thead',
              null,
              createElement(
                'tr',
                null,
                each.head.map((cell, at) => createElement('th', { key: at, scope: 'col' }, cell)),
              ),
            ),
            createElement(
              'tbody',
              null,
              each.rows.map((row, at) =>
                createElement(
                  'tr',
                  { key: at },
                  row.map((cell, column) => createElement('td', { key: column }, cell)),
                ),
              ),
            ),
          )
  const html = createElement(
    'html',
    { lang: 'ru' },
    createElement(
      'head',
      null,
      createElement('meta', { charSet: 'utf-8' }),
      createElement('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      createElement('meta', { name: 'robots', content: 'noindex, nofollow' }),
      createElement('title', null, input.title),
      createElement('style', { dangerouslySetInnerHTML: { __html: READING_PAGE_CSS } }),
    ),
    createElement(
      'body',
      null,
      createElement(
        'main',
        null,
        createElement(
          'article',
          null,
          createElement('h1', null, input.title),
          ...input.parts.map(part),
        ),
      ),
    ),
  )
  return `<!doctype html>${renderToStaticMarkup(html)}`
}
