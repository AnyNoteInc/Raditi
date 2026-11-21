// Counts of the synthetic corpus straight from its generator, without the page: what a search,
// a filter and the phone screen should show on an unedited table.
import { makeRows } from '../rebuild/src/data.ts'
const rows = makeRows(300, 1)
const fold = (t) => t.toLowerCase().replaceAll('ё', 'е')
const hay = (r) => fold(`${r.name}\n${r.category}\n${r.unit}\n${r.note}`)
const count = (w) => rows.filter((r) => hay(r).includes(fold(w))).length
console.log('пирог', count('пирог'), '| ёлочная', count('ёлочная'), '| торт', count('торт'))
console.log('Торты without stock', rows.filter((r) => r.category === 'Торты' && !r.inStock).length)
console.log('rows with «Ёлочная» in the note', rows.filter((r) => /ёлочная/i.test(r.note)).length, 'in the name', rows.filter((r) => /ёлочная/i.test(r.name)).length)
const idx = rows.map((r, i) => [i, r]).filter(([, r]) => fold(r.note).includes('елочная')).map(([i]) => i)
console.log('indexes with ёлочная:', idx.join(','))
