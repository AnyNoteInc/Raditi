// For each diagram an engine rejects: the one-step fix a model would make after reading the engine's
// error message (written by hand here, not by a model), and whether both engines accept the result.
//   node fixes.mjs
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { corpus } from './corpus.mjs'
import { MermaidPage, LOCKED_SECURE } from './lib/mermaid-renderer.mjs'
import { BmPool } from './lib/bm-renderer.mjs'
import { normalizeSource } from './lib/normalize.mjs'
import { textStream, labelRecall } from './lib/sanitize.mjs'

const src = (id) => corpus.find((c) => c.id === id).source
export const fixes = {
  F07: { what: 'подписи со скобками — в кавычки', text: src('F07').replace('B[Администратор (Мария) проверяет график]', 'B["Администратор (Мария) проверяет график"]').replace('D[Запись в CRM (YCLIENTS)]', 'D["Запись в CRM (YCLIENTS)"]').replace('F[Напоминание за 24 часа (SMS)]', 'F["Напоминание за 24 часа (SMS)"]') },
  F08: { what: 'end → finish[Конец]', text: src('F08').replaceAll('-->|Нет| end', '-->|Нет| finish[Конец]').replaceAll('cert --> end', 'cert --> finish') },
  F09: { what: 'graph TD; → graph TD (для beautiful-mermaid)', text: src('F09').replace('graph TD;', 'graph TD') },
  F11: { what: 'внутренние кавычки → «»', text: src('F11').replace('"Тариф "Бизнес""', '"Тариф «Бизнес»"') },
  F12: { what: 'снять ограждение ``` (нормализация)', text: normalizeSource(src('F12')) },
  S02: { what: '; в сообщении → #59;', text: src('S02').replace('файлы клиента; секреты', 'файлы клиента#59; секреты') },
  S03: { what: '; → , и закрыть loop словом end', text: src('S03').replace('Здравствуйте; сколько', 'Здравствуйте, сколько').replace('        Бот->>Менеджер: Есть необработанные вопросы', '        Бот->>Менеджер: Есть необработанные вопросы\n    end') },
  G02: { what: 'даты в dateFormat, excludes weekends, after', text: 'gantt\n    title Ремонт кухни\n    dateFormat YYYY-MM-DD\n    excludes weekends\n    section Работы\n    Демонтаж        :dem, 2026-11-20, 2d\n    Электрика       :el, 2026-11-23, 3d\n    Сборка мебели   :after el, 2d' },
  P02: { what: 'подписи в кавычки, точка вместо запятой, без %', text: 'pie title Расходы салона за октябрь\n    "Аренда" : 45\n    "Зарплата мастеров" : 30.5\n    "Материалы" : 15.5\n    "Реклама" : 9' },
  X01: { what: 'категории оси в кавычки', text: src('X01').replace('[Янв, Фев, Мар, Апр, Май, Июн]', '["Янв", "Фев", "Мар", "Апр", "Май", "Июн"]') },
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mermaidJs = readFileSync(new URL('./node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8')
  const browser = await chromium.launch()
  const mp = await new MermaidPage(browser, { mermaidJs }).open()
  const bm = new BmPool()
  const rows = ['| id | Правка | bm: до → после | Mermaid: до → после | Подписи после (bm / Mermaid) |', '|---|---|---|---|---|']
  for (const [id, f] of Object.entries(fixes)) {
    const d = corpus.find((c) => c.id === id)
    const [b0, b1] = [await bm.render(d.source, {}, 10000, false), await bm.render(f.text, {}, 10000, false)]
    const [m0, m1] = [await mp.render(d.source, { htmlLabels: false, seed: id + 'x0', secure: LOCKED_SECURE }, 10000), await mp.render(f.text, { htmlLabels: false, seed: id + 'x1', secure: LOCKED_SECURE }, 10000)]
    const yn = (r) => (r.svg ? 'да' : 'нет')
    const lab = (r) => (r.svg ? (({ found, total }) => `${found}/${total}`)(labelRecall(textStream(r.svg), d.labels)) : '—')
    rows.push(`| ${id} | ${f.what} | ${yn(b0)} → ${yn(b1)} | ${yn(m0)} → ${yn(m1)}${m1.svg ? '' : ` (${String(m1.error).slice(0, 60)})`} | ${lab(b1)} / ${lab(m1)} |`)
  }
  console.log(rows.join('\n'))
  await bm.close(); await mp.close(); await browser.close()
}
