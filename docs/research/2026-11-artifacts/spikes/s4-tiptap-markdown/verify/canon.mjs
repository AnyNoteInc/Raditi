// My own canonical form with the options plan 88 §7.7 names (bullet "-", no pipe padding), and the
// reader's text as the real doc-render draws it (jsdom textContent of DocumentMarkdown).
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkStringify from 'remark-stringify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { DocumentMarkdown } from './repo/packages/doc-render/src/document-markdown.ts'
const proc = unified().use(remarkParse).use(remarkGfm, { tablePipeAlign: false }).use(remarkStringify, { bullet: '-', listItemIndent: 'one', rule: '-', emphasis: '*', strong: '*', fence: '`' })
export const canon = (md) => String(proc.processSync(md))
export const html = (md) => renderToStaticMarkup(createElement(DocumentMarkdown, { text: md, documents: new Set(), imageSrc: (n) => n }))
const frag = new JSDOM('').window.document
export const seen = (md) => { const el = frag.createElement('div'); el.innerHTML = html(md); return el.textContent.replace(/[ \t\n\r]+/g, ' ').trim() }
