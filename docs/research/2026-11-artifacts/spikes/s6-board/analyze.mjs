// Reads results.json (or the files given) of measure.mjs and prints:
//  1. the spread between repeats of every row: metrics whose repeats differ by more than 20 % of
//     their mean (with an absolute floor, so 0 against 1 long frame is not a spread);
//  2. tables for the report: the laptop (default processes), the laptop special rows, the phone,
//     the price of one live frame, and the load averages of every repeat.
//   node analyze.mjs [results.json ...]   — several files are pooled (a rerun next to the full run)
import fs from 'node:fs'

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const runs = []
for (const f of files.length ? files : ['results.json']) {
  const r = JSON.parse(fs.readFileSync(f, 'utf8'))
  for (const x of r.runs) runs.push({ ...x, file: f })
}

const get = {
  readyMs: (r) => r.readyMs,
  liveLoadP50: (r) => r.liveLoadMs?.p50,
  loadMB: (r) => r.memLoad.total,
  deepMB: (r) => r.memDeep?.total,
  endMB: (r) => r.memEnd.total,
  cabinetMB: (r) => r.memLoad.cabinet,
  framesMB: (r) => r.memLoad.frames,
  gpuMB: (r) => r.memLoad.gpu,
  gpuDeepMB: (r) => r.memDeep?.gpu,
  fps: (r) => r.frames.fps,
  p95: (r) => r.frames.p95,
  p99: (r) => r.frames.p99,
  max: (r) => r.frames.max,
  over50: (r) => r.frames.over50,
  longTasks: (r) => r.frames.longTasks,
  inputP95: (r) => r.inputMs.p95,
  mainTaskMs: (r) => r.main.taskMs,
  mainShare: (r) => Math.round((1000 * r.main.taskMs) / r.frames.durationMs) / 10, // % of the scenario
  durS: (r) => Math.round(r.frames.durationMs / 100) / 10,
}
// absolute floors under which a difference is noise
const FLOOR = { readyMs: 50, liveLoadP50: 30, loadMB: 0, deepMB: 0, endMB: 0, cabinetMB: 5, framesMB: 5, gpuMB: 0, gpuDeepMB: 0, fps: 0, p95: 2, p99: 4, max: 20, over50: 3, longTasks: 3, inputP95: 10, mainTaskMs: 300, mainShare: 3, durS: 3 }
const CHECKED = ['readyMs', 'liveLoadP50', 'loadMB', 'endMB', 'cabinetMB', 'framesMB', 'gpuMB', 'fps', 'p95', 'p99', 'over50', 'inputP95']

const byId = new Map()
for (const r of runs) { if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id).push(r) }

const med = (xs) => { const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10 }
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10)
const fmt = (x) => (x == null ? '—' : String(x).replace('.', ','))
const span = (xs) => { const v = xs.filter((x) => typeof x === 'number'); if (!v.length) return '—'; const a = Math.min(...v), b = Math.max(...v); return a === b ? fmt(a) : `${fmt(a)}–${fmt(b)}` }

// --- 1. spread -------------------------------------------------------------------------------
const spread = []
for (const [id, rs] of byId) {
  if (rs.length < 2) continue
  for (const k of CHECKED) {
    const v = rs.map(get[k]).filter((x) => typeof x === 'number')
    if (v.length < 2) continue
    const lo = Math.min(...v), hi = Math.max(...v), mean = v.reduce((a, b) => a + b, 0) / v.length
    if (hi - lo <= FLOOR[k]) continue
    const rel = mean ? (hi - lo) / mean : 0
    if (rel > 0.2) spread.push({ id, k, v, rel: Math.round(rel * 100) })
  }
}
console.log(`runs: ${runs.length}, rows: ${byId.size}`)
console.log(`\n## Spread over 20 % between repeats (${spread.length})\n`)
for (const s of spread) console.log(`${s.id} — ${s.k}: ${s.v.join(' / ')} (${s.rel} %)`)
// the largest spread of every row over the checked metrics (above their floors), whatever its size
console.log('\n## Largest spread of every row\n')
console.log('| Прогон | Повторов | Наибольший разброс, % | Метрика | Значения |')
console.log('| --- | --- | --- | --- | --- |')
for (const [id, rs] of byId) {
  let best = null
  for (const k of CHECKED) {
    const v = rs.map(get[k]).filter((x) => typeof x === 'number')
    if (v.length < 2) continue
    const lo = Math.min(...v), hi = Math.max(...v), mean = v.reduce((a, b) => a + b, 0) / v.length
    if (hi - lo <= FLOOR[k] || !mean) continue
    const rel = (hi - lo) / mean
    if (!best || rel > best.rel) best = { k, v, rel }
  }
  console.log(best ? `| ${id} | ${rs.length} | ${Math.round(best.rel * 100)} | ${best.k} | ${best.v.map(fmt).join(' / ')} |` : `| ${id} | ${rs.length} | 0 | — | — |`)
}

// --- 2. tables -------------------------------------------------------------------------------
const row = (id) => { const rs = byId.get(id); if (!rs) return null; const o = { id, n: rs.length }; for (const k of Object.keys(get)) o[k] = med(rs.map(get[k])); o.la = rs.map((r) => r.loadavgBefore[0]); o.rs = rs; return o }
const ids = [...byId.keys()]
const base = (r) => {
  const [device, impl] = r.id.split(' ')
  const proc = r.id.includes('shared') ? 'shared' : 'default'
  return row(`${device} ${impl} live0 ${proc}`)
}
const plus = (r) => { const b = base(r); return b && b.id !== r.id ? r1(r.loadMB - b.loadMB) : null }
const perFrame = (r) => { const n = Number(/live(\d+)/.exec(r.id)?.[1]); const p = plus(r); return p != null && n ? r1(p / n) : null }

const memHead = '| Прогон | Повторов | Готов, мс | Загрузка живой рамки p50, мс | Память после загрузки, МБ | +к live0, МБ | За рамку, МБ | При приближении, МБ | В конце, МБ | Кабинет, МБ | Рамки, МБ | GPU, МБ | GPU при приближении, МБ |'
const memRow = (r) => `| ${r.id} | ${r.n} | ${fmt(r.readyMs)} | ${fmt(r.liveLoadP50)} | ${fmt(r.loadMB)} | ${fmt(plus(r))} | ${fmt(perFrame(r))} | ${fmt(r.deepMB)} | ${fmt(r.endMB)} | ${fmt(r.cabinetMB)} | ${fmt(r.framesMB)} | ${fmt(r.gpuMB)} | ${fmt(r.gpuDeepMB)} |`
const fpsHead = '| Прогон | к/с | p95, мс | p99, мс | макс, мс | Кадров >50 мс | Длинных задач | Ввод p95, мс | Главный поток, % | Сценарий, с | Нагрузка (1 мин) |'
const fpsRow = (r) => `| ${r.id} | ${fmt(r.fps)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.max)} | ${fmt(r.over50)} | ${fmt(r.longTasks)} | ${fmt(r.inputP95)} | ${fmt(r.mainShare)} | ${fmt(r.durS)} | ${r.la.map(fmt).join('; ')} |`
const sep = (h) => '|' + ' --- |'.repeat(h.split('|').length - 2)

function section(title, pick) {
  const rows = ids.filter(pick).map(row)
  if (!rows.length) return
  console.log(`\n## ${title}\n\n${memHead}\n${sep(memHead)}\n${rows.map(memRow).join('\n')}\n\n${fpsHead}\n${sep(fpsHead)}\n${rows.map(fpsRow).join('\n')}`)
}
const special = (id) => /busy|hz|cross|shared/.test(id)
section('Laptop, default processes', (id) => id.startsWith('laptop') && !special(id))
section('Laptop, special rows', (id) => id.startsWith('laptop') && special(id))
section('Phone', (id) => id.startsWith('phone'))

// every repeat on its own: the spread in one place
console.log('\n## Every repeat\n')
console.log('| Прогон | Повтор | Готов, мс | Память после загрузки / в конце, МБ | GPU, МБ | к/с | p95, мс | p99, мс | Кадров >50 мс | Ввод p95, мс | Нагрузка до / после |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const [id, rs] of byId) for (const r of rs) console.log(`| ${id} | ${r.rep}${files.length > 1 ? ` (${r.file})` : ''} | ${r.readyMs} | ${fmt(r.memLoad.total)} / ${fmt(r.memEnd.total)} | ${fmt(r.memLoad.gpu)} | ${fmt(r.frames.fps)} | ${fmt(r.frames.p95)} | ${fmt(r.frames.p99)} | ${r.frames.over50} | ${fmt(r.inputMs.p95)} | ${r.loadavgBefore.map(fmt).join(' ')} → ${r.loadavgAfter.map(fmt).join(' ')} |`)

// the processes of one repeat of a few rows: where the memory sits
console.log('\n## Processes after load (first repeat)\n')
for (const id of ids.filter((x) => /live(0|2|20) /.test(x) && !/busy|hz|cross/.test(x))) {
  const r = byId.get(id)[0]
  console.log(`${id}: ` + r.memLoad.procs.map((p) => `${p.role}=${fmt(p.footprintMB)}${p.tilesMB ? ` (tiles ${fmt(p.tilesMB)}, img ${fmt(Math.max(p.imagesMB, p.discardableMB))}, v8 ${fmt(p.v8MB)})` : ''}`).join(', '))
}
const lavg = runs.map((r) => r.loadavgBefore[0])
console.log(`\nload average (1 min) before runs: ${span(lavg)}, median ${fmt(med(lavg))}`)
