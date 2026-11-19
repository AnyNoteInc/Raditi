// What @repo/doc-render shows today (react-markdown 10.1.0, remark-gfm, skipHtml: true — as
// packages/doc-render/src/document-markdown.ts), for the constructs where the spike says the
// display itself already differs from what the agent meant.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const drawn = (text) =>
  renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm], skipHtml: true, children: text }))

const cases = {
  'br в абзаце': 'Нажмите Esc, чтобы закрыть окно.<br>Вторая строка.',
  'br в ячейке': '| День | Часы |\n|---|---|\n| Сб | 10:00–18:00<br>(обед 14:00–15:00) |',
  'details/summary': '<details>\n<summary>Подробнее</summary>\n\nСкрытый текст.\n\n</details>',
  'div в строку': '<div align="right">Подпись справа</div>',
  'метка без пробела': '**Цена:**1990 ₽',
  'метка с пробелом': '**Цена:** 1990 ₽',
  'кавычки вокруг выделения': '«**Акция**» и **«Акция»**',
}
for (const [name, text] of Object.entries(cases)) console.log(`${name}\n  ${JSON.stringify(text)}\n  → ${drawn(text)}`)
