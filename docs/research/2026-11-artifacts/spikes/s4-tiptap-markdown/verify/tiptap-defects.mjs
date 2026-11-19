// Independent repro of the @tiptap/markdown 3.34.0 defects the report names: an editor built with
// the Markdown as its initial content (not setContent), the plan's extension set, my own canon and
// the real doc-render text. Each case: A (canonical), what Tiptap wrote, C, and the verdict.
import './dom.mjs'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TableKit } from '@tiptap/extension-table'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import Image from '@tiptap/extension-image'
import { canon, seen, html } from './canon.mjs'

const NB = ' ', NN = ' '
const cases = {
  'nbsp в ячейке': `| Услуга | Цена |\n|---|---|\n| Стрижка | 1${NB}990${NB}₽ |`,
  'узкий nbsp в ячейке': `| Услуга | Цена |\n|---|---|\n| Укладка | 2${NN}500${NN}₽ |`,
  'nbsp вне таблицы': `Цена 1${NB}990${NB}₽ и **до${NB}10${NB}000${NB}₽**`,
  'nbsp в заголовке и списке': `### Стрижка за 1${NB}990${NB}₽\n\n- Укладка 990${NB}₽`,
  'сноска': 'Цена с НДС[^1].\n\n[^1]: НДС не облагается.',
  'решётка': '\\# не заголовок',
  'год с точкой': '1990\\. Год основания',
  'дефис': '\\- не список',
  'плюс': '\\+ и не этот',
  'черта под строкой': 'Итого\n\\---',
  'кавычка в подсказке': '[Каталог](https://example.ru "Он сказал \\"да\\"")',
  'пробел в адресе': '[Файл](<./мой файл.md>)',
  'курсив вокруг кода': '*`код`*',
  'забор в коде': '````md\n```\nвложенный\n```\n````',
  'нумерация с 0': '0. нулевой\n1. первый',
  'картинка в строке': 'Смотрите ![значок](icon.png) рядом.',
  'картинка-ссылка': '[![Логотип](logo.png)](https://example.ru)',
  'кавычки, тире, ё': '«Ёлочки», „лапки“ — тире, ещё',
}

function editorFor(md, inlineImage) {
  const el = document.createElement('div')
  document.body.append(el)
  return new Editor({
    element: el,
    extensions: [StarterKit, TableKit, TaskList, TaskItem.configure({ nested: true }), Image.configure({ inline: inlineImage }), Markdown],
    content: md,
    contentType: 'markdown',
  })
}

for (const [name, raw] of Object.entries(cases)) {
  const a = canon(raw)
  for (const inlineImage of [false, true]) {
    if (inlineImage && !name.startsWith('картинка')) continue
    let out, c, verdict
    try {
      const ed = editorFor(a, inlineImage)
      out = ed.getMarkdown()
      ed.destroy()
      c = canon(out)
      verdict = c === a ? 'байт в байт' : html(a) === html(c) ? 'другой исходник, тот же показ' : seen(a) === seen(c) ? 'другой показ, те же слова' : 'ДРУГИЕ СЛОВА'
    } catch (e) {
      verdict = 'СБОЙ: ' + String(e.message).slice(0, 90)
    }
    const show = (s) => JSON.stringify(s ?? '').replaceAll(NB, '⍽').replaceAll(NN, '⎵')
    console.log(`${name}${inlineImage ? ' (Image inline)' : ''}: ${verdict}\n   A=${show(a)}\n   T=${show(out)}\n   C=${show(c)}`)
  }
}
