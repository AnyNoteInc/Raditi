// At how many rows of the corpus does a file inside the .xlsx reach fflate's 160 000 bytes,
// the size from which its async zip() compresses in a Web Worker made from a blob: URL?
// Uses write-excel-file's own generator of the inner files (the same input as csp/main.js).
import generate from '../rebuild/node_modules/write-excel-file/modules/xlsx/generateXlsxFileContents.js'
import { makeRows } from '../rebuild/src/data.ts'

const enc = new TextEncoder()
const header = ['Название', 'Категория', 'Ед.', 'Цена, ₽', 'В наличии', 'Примечание'].map((value) => ({ value, fontWeight: 'bold' }))
for (const n of [300, 500, 600, 650, 700, 725, 750, 800, 900, 1000, 1500, 5000]) {
  const rows = makeRows(n, 1)
  const body = rows.map((r) => [
    { value: r.name, type: String },
    { value: r.category, type: String },
    { value: r.unit, type: String },
    r.price === '' ? null : { value: Number(r.price), type: Number, format: '#,##0.00' },
    { value: r.inStock ? 'да' : 'нет', type: String },
    { value: r.note, type: String },
  ])
  const files = generate([header, ...body], { sheet: 'Прайс-лист', stickyRowsCount: 1 })
  const sizes = Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v).length : v.length])
  const [biggest, bytes] = sizes.sort((a, b) => b[1] - a[1])[0]
  console.log(`${String(n).padStart(5)} rows: largest inner file ${biggest} ${bytes} bytes → ${bytes >= 160000 ? 'worker (blob:)' : 'in the page'}`)
}
