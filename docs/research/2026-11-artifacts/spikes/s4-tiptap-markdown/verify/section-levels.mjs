// A section of a document may not open headings of the first or second level (sectionMarkdownProblem
// of @repo/domain, plans 69 and 74). Does the canon of the bridge (setext: false) or the editor turn
// a section that passes into one that is refused?
import { sectionMarkdownProblem } from './repo/packages/domain/src/pages/doc.ts'
import { canonBridge, pmToMd } from '../lib/remark-bridge.mjs'
import { canonPlan } from '../lib/canon.mjs'
const cases = {
  'подчёркнутый заголовок второго уровня': 'Итоги месяца\n---\n\nВыручка выросла.',
  'подчёркнутый заголовок первого уровня': 'Итоги месяца\n===\n\nВыручка выросла.',
  'экранированная черта (Tiptap снимает экран)': 'Итого\n\\---',
}
for (const [name, raw] of Object.entries(cases)) {
  console.log(`${name}: агент ${sectionMarkdownProblem(raw) ?? 'принят'}; канон моста ${sectionMarkdownProblem(canonBridge(raw)) ?? 'принят'} ${JSON.stringify(canonBridge(raw).split('\n')[0])}; канон plan ${sectionMarkdownProblem(canonPlan(raw)) ?? 'принят'}`)
}
// a person picks «Заголовок 2» in the editor of a section: the bridge writes it as it is
const doc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Новый раздел' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Текст.' }] }] }
console.log('заголовок второго уровня из редактора:', JSON.stringify(pmToMd(doc)), '→', sectionMarkdownProblem(pmToMd(doc)) ?? 'принят')
