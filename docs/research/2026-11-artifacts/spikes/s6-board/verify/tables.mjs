// My own aggregation of the spike's raw results (not its analyze.mjs): medians of the repeats, printed in
// the order and units of the README tables §4, §6, §7, §8 and §9, so they can be compared cell by cell.
//   node tables.mjs <results.json> [results-rerun.json]
import fs from 'node:fs'

const [main, rerun] = process.argv.slice(2)
const runs = JSON.parse(fs.readFileSync(main, 'utf8')).runs
const rer = rerun ? JSON.parse(fs.readFileSync(rerun, 'utf8')).runs : []
const by = (id, src = runs) => src.filter((r) => r.id === id)
const median = (xs) => { const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const r0 = (x) => (x == null ? '—' : String(Math.round(x)))
const r1 = (x) => (x == null ? '—' : (Math.round(x * 10) / 10).toFixed(1).replace('.', ','))
const pick = (id, f) => median(by(id).map(f))
const share = (r) => (100 * r.main.taskMs) / r.frames.durationMs

function memTable(ids, base) {
  console.log('| id | готова | рамка p50 | после загрузки | + к 0 | за рамку | при приближении | в конце | кабинет | рамки | GPU | n |')
  for (const id of ids) {
    const n = Number(/live(\d+)/.exec(id)?.[1])
    const load = pick(id, (r) => r.memLoad.total)
    const b = base?.(id) ? pick(base(id), (r) => r.memLoad.total) : null
    const plus = b != null && base(id) !== id ? load - b : null
    console.log(`| ${id} | ${r0(pick(id, (r) => r.readyMs))} | ${r0(pick(id, (r) => r.liveLoadMs?.p50))} | ${r0(load)} | ${plus == null ? '—' : r0(plus)} | ${plus != null && n ? r0(plus / n) : '—'} | ${r0(pick(id, (r) => r.memDeep?.total))} | ${r0(pick(id, (r) => r.memEnd.total))} | ${r0(pick(id, (r) => r.memLoad.cabinet))} | ${r0(pick(id, (r) => r.memLoad.frames))} | ${r0(pick(id, (r) => r.memLoad.gpu))} | ${by(id).length} |`)
  }
}
function fpsTable(ids) {
  console.log('| id | к/с | p95 | p99 | макс | >50 мс | длинных задач | ввод p95 | главный поток % | сценарий с | нагрузка |')
  for (const id of ids) {
    console.log(`| ${id} | ${r1(pick(id, (r) => r.frames.fps))} | ${r1(pick(id, (r) => r.frames.p95))} | ${r1(pick(id, (r) => r.frames.p99))} | ${r1(pick(id, (r) => r.frames.max))} | ${r1(pick(id, (r) => r.frames.over50))} | ${r0(pick(id, (r) => r.frames.longTasks))} | ${r1(pick(id, (r) => r.inputMs.p95))} | ${r1(pick(id, share))} | ${r1(pick(id, (r) => r.frames.durationMs / 1000))} | ${by(id).map((r) => r1(r.loadavgBefore[0])).join('; ')} |`)
  }
}
const lap = (impl) => ['0', '2', '6', '12', '20', 'auto4'].map((l) => `laptop ${impl} live${l} default`)
console.log('\n§6 ноутбук, память'); memTable([...lap('css'), ...lap('xyflow')], (id) => id.replace(/live\w+/, 'live0'))
const special = ['laptop css live20 default hz', 'laptop css live20 default cross-site', 'laptop css live6 shared', 'laptop css live20 shared', 'laptop css live2 default busy', 'laptop css live2 default busy hz', 'laptop css live2 shared busy']
console.log('\n§6 особые строки'); memTable(special, null)
console.log('\n§7 ноутбук, плавность'); fpsTable([...lap('css'), ...lap('xyflow'), special[0], special[1], special[2], special[3]])
console.log('\n§4 тяжёлая рамка, весь сценарий'); fpsTable([special[4], special[5], special[6], 'laptop css live2 default'])
const ph = ['phone css live0 shared', 'phone css live2 shared', 'phone css live6 shared', 'phone css live12 shared', 'phone css live20 shared', 'phone xyflow live2 shared', 'phone xyflow live20 shared', 'phone list live0 shared', 'phone css live6 default']
console.log('\n§8 телефон, память (+к 0 — в конце)')
console.log('| id | готова | рамка p50 | после загрузки | при приближении | в конце | + к 0 в конце | кабинет загрузка / конец | GPU загрузка |')
const end0 = pick('phone css live0 shared', (r) => r.memEnd.total)
for (const id of ph) console.log(`| ${id} | ${r0(pick(id, (r) => r.readyMs))} | ${r0(pick(id, (r) => r.liveLoadMs?.p50))} | ${r0(pick(id, (r) => r.memLoad.total))} | ${r0(pick(id, (r) => r.memDeep?.total))} | ${r0(pick(id, (r) => r.memEnd.total))} | ${id.startsWith('phone css') && id.includes('shared') && !id.includes('live0') ? '+' + r0(pick(id, (r) => r.memEnd.total) - end0) : '—'} | ${r0(pick(id, (r) => r.memLoad.cabinet))} / ${r0(pick(id, (r) => r.memEnd.cabinet))} | ${r0(pick(id, (r) => r.memLoad.gpu))} |`)
console.log('\n§8 телефон, плавность'); fpsTable(ph)
console.log('\n§9 повторы четырёх строк')
for (const id of ['laptop css live6 shared', 'laptop css live20 shared', 'phone css live6 shared', 'phone css live12 shared']) {
  for (const [src, label] of [[runs, 'полный'], [rer, 'повтор']]) for (const r of by(id, src)) console.log(`| ${id} | ${label} ${r.rep} | ${r.readyMs} | ${r1(r.memLoad.total)} / ${r1(r.memEnd.total)} | ${r1(r.memLoad.gpu)} | ${r1(r.frames.fps)} | ${r1(r.frames.p95)} | ${r1(r.inputMs.p50)} / ${r1(r.inputMs.p95)} | ${r1(r.loadavgBefore[0])} |`)
}
// facts the README states in words
const lapLive = runs.filter((r) => r.device === 'laptop' && r.proc === 'default' && !/auto/.test(r.live) && r.live !== '0')
console.log('\nноутбук по умолчанию с живыми рамками: прогонов', lapLive.length, '— процессов рамок:', [...new Set(lapLive.map((r) => r.frameProcesses))], 'OOPIF:', [...new Set(lapLive.map((r) => r.oopif))].join(','))
const la = runs.map((r) => r.loadavgBefore[0]).sort((a, b) => a - b)
console.log('нагрузка за минуту перед строками:', la[0], '–', la.at(-1), 'медиана', median(la))
const auto = runs.filter((r) => r.live === 'auto4')
for (const r of auto) {
  const rend = r.memEnd.procs.filter((p) => /renderer/i.test(p.role) || /Renderer/.test(p.name)).map((p) => `${p.role}:${p.name}:${Math.round(p.footprintMB)}`)
  console.log('auto4 в конце', r.id, r.rep, 'живых в конце', r.liveAtEnd, 'рендереры:', rend.join(', '))
}
