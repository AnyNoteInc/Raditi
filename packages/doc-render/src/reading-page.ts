import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DocumentMarkdown } from './document-markdown.ts'

// The page for reading (docs/plan/69-pages.md, Ст11): a text document drawn once into HTML by the
// very tree and rules of the cabinet's tab, dressed in Raditi's own style, nothing loaded from
// anywhere. It is served under PAGE_READING_CSP — no script at all — so it carries none.

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
export function readingPage({ title, markdown }: ReadingPageInput): string {
  const article = createElement(DocumentMarkdown, {
    text: markdown,
    documents: new Set<string>(),
    imageSrc: () => null,
    documentLinks: false,
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
