// A page without React or the table: write-excel-file/browser on rows shaped like the spike's
// export (six columns, the same synthetic corpus), to see when it needs a blob: worker.
import writeExcelFile from 'write-excel-file/browser'
import { makeRows } from '../../rebuild/src/data.ts'

window.violations = []
document.addEventListener('securitypolicyviolation', (e) => window.violations.push(`${e.effectiveDirective} ${e.blockedURI.slice(0, 5)}`))

window.run = async (n) => {
  const rows = makeRows(n, 1)
  const header = ['Название', 'Категория', 'Ед.', 'Цена, ₽', 'В наличии', 'Примечание'].map((value) => ({ value, fontWeight: 'bold' }))
  const body = rows.map((r) => [
    { value: r.name, type: String },
    { value: r.category, type: String },
    { value: r.unit, type: String },
    r.price === '' ? null : { value: Number(r.price), type: Number, format: '#,##0.00' },
    { value: r.inStock ? 'да' : 'нет', type: String },
    { value: r.note, type: String },
  ])
  const t0 = performance.now()
  const blob = await writeExcelFile([header, ...body], { sheet: 'Прайс-лист', stickyRowsCount: 1 }).toBlob()
  return { ms: Math.round(performance.now() - t0), bytes: blob.size }
}
window.ready = true
