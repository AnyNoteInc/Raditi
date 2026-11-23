// Clipboard text as Excel and Google Sheets put it, written by hand after their rules (no
// spreadsheet was run): Excel ends rows with CRLF and adds one at the very end, Google Sheets uses
// LF and adds nothing; a cell with a line break, a tab or a quote is quoted, quotes are doubled.
import { makeRows } from '../src/data.ts'

const NB = ' '

/** Excel with a Russian locale, columns «Ед.», «Цена, ₽», «В наличии». */
export const excelRu3x3 = `шт\t1${NB}234,56 ₽\tИСТИНА\r\n100 г\t89,9\tЛОЖЬ\r\nкг\t12${NB}900\tИСТИНА\r\n`
export const excelRu3x3Expected = [
  { unit: 'шт', price: '1234.56', inStock: true },
  { unit: '100 г', price: '89.90', inStock: false },
  { unit: 'кг', price: '12900.00', inStock: true },
]

/** Google Sheets with an English locale, all six columns, a quoted cell with a line break. */
export const sheetsEn2x6 = 'Торт «Ягодный» мини\tТорты\tшт\t1,250.00\tTRUE\t"Две строки:\nкрем и ягоды"\nКвас 1 л\tнапитки\tл\t₽95.50\tFALSE\tс "кавычками"'
export const sheetsEn2x6Expected = [
  { name: 'Торт «Ягодный» мини', category: 'Торты', unit: 'шт', price: '1250.00', inStock: true, note: 'Две строки:\nкрем и ягоды' },
  { name: 'Квас 1 л', category: 'Напитки', unit: 'л', price: '95.50', inStock: false, note: 'с "кавычками"' },
]

/** Values that do not fit: a word in a price, an unknown category, a «maybe» in a flag. */
export const badRow = 'Пицца\tабв\tможет быть'

/** `count` rows of six columns in Google Sheets form with a Russian locale. */
export function sheetsRows(count, seed = 7) {
  const rows = makeRows(count, seed)
  const cell = (text) => (/[\t\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text)
  const price = (p) => {
    const [r, k] = p.split('.')
    const grouped = r.replace(/\B(?=(\d{3})+(?!\d))/g, NB)
    return k === '00' ? grouped : `${grouped},${k}`
  }
  const lines = rows.map((r, i) =>
    [r.name, r.category, r.unit, price(r.price), r.inStock ? 'ИСТИНА' : 'ЛОЖЬ', i % 50 === 0 ? `${r.note}\nвторая строка` : r.note]
      .map(cell)
      .join('\t'),
  )
  return { text: lines.join('\n'), rows }
}
