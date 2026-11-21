// Independent check of the two doc-render findings, through the real DocumentMarkdown and
// rehypeDocumentRules of the repository (copied verbatim, run by Node type stripping), not a copy
// of the filter. Prints the rendered HTML and the text a reader sees (jsdom textContent).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { DocumentMarkdown } from './repo/packages/doc-render/src/document-markdown.ts'

const draw = (text) =>
  renderToStaticMarkup(createElement(DocumentMarkdown, { text, documents: new Set(), imageSrc: () => null }))
const seen = (html) => new JSDOM(`<body>${html}</body>`).window.document.body.textContent

const cases = {
  'br в абзаце': 'Нажмите Esc, чтобы закрыть окно.<br>Вторая строка.',
  'br с пробелами': 'Первая строка <br> вторая',
  'br в ячейке': '| День | Часы |\n|---|---|\n| Сб | 10:00–18:00<br>(обед 14:00–15:00) |',
  'сноска': 'Цена указана с НДС[^1].\n\n[^1]: Продавец — самозанятый, НДС не облагается.',
  'выравнивание столбцов': '| Услуга | Цена |\n|:--|--:|\n| Стрижка | 1 990 ₽ |',
}
for (const [name, text] of Object.entries(cases)) {
  const html = draw(text)
  console.log(`## ${name}\n  html: ${html}\n  text: ${JSON.stringify(seen(html))}`)
}
