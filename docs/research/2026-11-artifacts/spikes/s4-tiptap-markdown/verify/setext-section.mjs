// A section that passes sectionMarkdownProblem today, drawn by the real doc-render.
import { sectionMarkdownProblem } from './repo/packages/domain/src/pages/doc.ts'
import { html } from './canon.mjs'
for (const body of ['Итоги месяца\n---\n\nВыручка выросла.', 'Итоги месяца\n===\n\nВыручка выросла.', '## Итоги месяца\n\nВыручка выросла.'])
  console.log(JSON.stringify(body), '→ check:', sectionMarkdownProblem(body) ?? 'принят', '| doc-render:', html(body).replace(/\n/g, ''))
