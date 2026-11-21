// Tables for the README from out/check-results.json (and results.json of measure.mjs, if present).
//   node report.mjs > out/tables.md
import { readFileSync, existsSync } from 'node:fs'

const j = JSON.parse(readFileSync(new URL('./out/check-results.json', import.meta.url), 'utf8'))
const ids = j.corpus.map((d) => d.id)
const C = Object.fromEntries(j.corpus.map((d) => [d.id, d]))
const R = j.rows
const D = j.display
const B = ['chromium', 'webkit', 'firefox'].filter((b) => D[b])
const out = []
const p = (...l) => out.push(...l)
const frac = (a, b) => `${a}/${b}`
const median = (a) => { const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(2) }
const short = (e) => String(e || '').replace(/\s+/g, ' ').replace(/\|/g, '¦').slice(0, 70)
const st = (r) => (r.ok ? 'да' : r.timedOut ? 'таймаут' : r.stage === 'render' ? 'нет (рендер)' : 'нет (разбор)')
const validRu = (v) => (v === true ? 'да' : v === false ? 'ошибка' : 'кириллица')

// 1. Per diagram
p('### Схемы по одной', '', '| id | Вид | Верна по документации | bm | bm: подписи | Mermaid | Mermaid: подписи | Чем отличаются |', '|---|---|---|---|---|---|---|---|')
for (const id of ids) {
  const b = R.bm[id], m = R['mm-text'][id]
  const notes = []
  if (b.ok && b.finalRecall.missing.length) notes.push(`bm не показывает: ${b.finalRecall.missing.slice(0, 3).map((x) => `«${x}»`).join(', ')}`)
  if (m.ok && m.finalRecall.missing.length) notes.push(`Mermaid не показывает: ${m.finalRecall.missing.slice(0, 3).map((x) => `«${x}»`).join(', ')}`)
  if (b.ok && b.leak.length) notes.push(`bm: разметка видна (${[...new Set(b.leak)].slice(0, 3).join(' ')})`)
  if (m.ok && m.leak.length) notes.push(`Mermaid: разметка видна (${[...new Set(m.leak)].slice(0, 4).join(' ')})`)
  if (!b.ok) notes.push(`bm: ${short(b.error)}`)
  if (!m.ok) notes.push(`Mermaid: ${short(m.error)}`)
  p(`| ${id} | ${C[id].type} | ${validRu(C[id].valid)} | ${st(b)} | ${b.ok ? frac(b.finalRecall.found, b.finalRecall.total) : '—'} | ${st(m)} | ${m.ok ? frac(m.finalRecall.found, m.finalRecall.total) : '—'} | ${notes.join('; ').replace(/\|/g, '¦')} |`)
}

// 2. By type and validity
p('', '### По видам', '', '| Вид | Схем | bm нарисовал | bm: все подписи | Mermaid нарисовал | Mermaid: все подписи |', '|---|---|---|---|---|---|')
const types = [...new Set(ids.map((id) => C[id].type))]
for (const t of types) {
  const list = ids.filter((id) => C[id].type === t)
  const okB = list.filter((id) => R.bm[id].ok), okM = list.filter((id) => R['mm-text'][id].ok)
  const fullB = okB.filter((id) => !R.bm[id].finalRecall.missing.length), fullM = okM.filter((id) => !R['mm-text'][id].finalRecall.missing.length)
  p(`| ${t} | ${list.length} | ${okB.length} | ${fullB.length} | ${okM.length} | ${fullM.length} |`)
}
p('', '| Группа | Схем | bm нарисовал | Mermaid нарисовал | Нарисовал хоть один | После нормализации: bm / Mermaid |', '|---|---|---|---|---|---|')
for (const [name, pred] of [['верные по документации', (v) => v === true], ['кириллические id', (v) => v === 'unicode'], ['намеренные ошибки', (v) => v === false], ['все', () => true]]) {
  const list = ids.filter((id) => pred(C[id].valid))
  const okB = list.filter((id) => R.bm[id].ok).length, okM = list.filter((id) => R['mm-text'][id].ok).length
  const any = list.filter((id) => R.bm[id].ok || R['mm-text'][id].ok).length
  const nb = list.filter((id) => j.normalized[id]?.bm.ok).length, nm = list.filter((id) => j.normalized[id]?.mm.ok).length
  p(`| ${name} | ${list.length} | ${okB} | ${okM} | ${any} | ${nb} / ${nm} |`)
}

// 3. Structure of flowcharts and state diagrams
p('', '### Структура блок-схем и диаграмм состояний', '', '| id | Mermaid: узлы / рёбра / группы (разбор) | bm: узлы / рёбра / группы (разбор) | Mermaid: нарисовано | bm: нарисовано |', '|---|---|---|---|---|')
for (const id of ids.filter((x) => ['flowchart', 'state'].includes(C[x].type))) {
  const m = R['mm-text'][id], b = R.bm[id]
  const ms = m.ok && m.structure ? `${m.structure.vertices ?? m.structure.states ?? '—'} / ${m.structure.edges ?? m.structure.relations ?? '—'} / ${m.structure.subgraphs ?? '—'}` : '—'
  const bs = b.ok && b.structure ? `${b.structure.vertices} / ${b.structure.edges} / ${b.structure.subgraphs}` : '—'
  const mr = m.ok ? `${m.rendered.nodes} / ${m.rendered.edges} / ${m.rendered.clusters}` : '—'
  const br = b.ok ? `${b.rendered.nodes} / ${b.rendered.edges} / ${b.rendered.clusters}` : '—'
  p(`| ${id} | ${ms} | ${bs} | ${mr} | ${br} |`)
}

// 4. Serialization and <img>
p('', '### Путь до картинки: XML и загрузка в <img>', '')
p(`| Что показываем | XML верен | ${B.map((b) => `${b}: загрузилась`).join(' | ')} | ${B.map((b) => `${b}: не своего размера`).join(' | ')} |`, `|---|---|${B.map(() => '---').join('|')}|${B.map(() => '---').join('|')}|`)
const rowsOf = (variant) => ids.filter((id) => R[variant][id].ok)
for (const [label, variant, kind, xmlKey] of [
  ['bm, как отдал движок', 'bm', 'raw', 'rawXml'], ['bm → DOMPurify, строка', 'bm', 'naive', 'naiveXml'], ['bm → итог', 'bm', 'final', 'finalXml'],
  ['Mermaid text, как отдал', 'mm-text', 'raw', 'rawXml'], ['Mermaid text → DOMPurify, строка', 'mm-text', 'naive', 'naiveXml'], ['Mermaid text → итог', 'mm-text', 'final', 'finalXml'],
  ['Mermaid html, как отдал', 'mm-html', 'raw', 'rawXml'], ['Mermaid html → DOMPurify, строка', 'mm-html', 'naive', 'naiveXml'], ['Mermaid html → итог (SVG-профиль)', 'mm-html', 'final', 'finalXml'], ['Mermaid html → итог (с foreignObject)', 'mm-html-fo', 'final', 'finalXml'],
]) {
  const list = rowsOf(variant)
  const xmlOk = list.filter((id) => R[variant][id][xmlKey]?.ok).length
  const cells = B.map((b) => frac(list.filter((id) => D[b].results[`${id}.${variant}.${kind}`]?.loaded).length, list.length))
  // "Its own size" = the viewBox size the final step writes into width and height.
  const own = (id) => R[variant][id].size
  const tiny = B.map((b) => list.filter((id) => { const x = D[b].results[`${id}.${variant}.${kind}`], o = own(id); return x?.loaded && o && (Math.abs(x.naturalWidth - o.width) > 2 || Math.abs(x.naturalHeight - o.height) > 2) }).length)
  p(`| ${label} | ${frac(xmlOk, list.length)} | ${cells.join(' | ')} | ${tiny.join(' | ')} |`)
}
const fails = (variant, kind) => [...new Set(B.flatMap((b) => ids.filter((id) => R[variant][id].ok && !D[b].results[`${id}.${variant}.${kind}`]?.loaded)))]
p('', `Не загрузились: bm строка — ${fails('bm', 'naive').join(', ') || 'нет'}; Mermaid text как отдал — ${fails('mm-text', 'raw').join(', ') || 'нет'}; Mermaid html как отдал — ${fails('mm-html', 'raw').join(', ') || 'нет'}; с foreignObject — ${fails('mm-html-fo', 'final').join(', ') || 'нет'}.`)
const xmlErrors = [...new Set(ids.flatMap((id) => ['bm', 'mm-text', 'mm-html'].flatMap((v) => [R[v][id].rawXml, R[v][id].naiveXml].filter((x) => x && !x.ok).map((x) => x.error.replace(/^\d+:\d+: /, '')))))]
p('', `Ошибки XML: ${xmlErrors.map((e) => `«${e}»`).join(', ')}.`)

// 4b. Against the engine's own inline render
p('', '### Сверка с родной отрисовкой движка', '', 'Эталон — SVG движка, вставленный в страницу, как в документации движка, той же ширины. Разница — доля пикселей, которые отличаются.', '')
p(`| Вариант | ${B.map((b) => `${b}: медиана разницы, %`).join(' | ')} | ${B.map((b) => `${b}: схем с разницей > 2 %`).join(' | ')} | ${B.map((b) => `${b}: «чернила» итог / эталон, %`).join(' | ')} |`, `|---|${B.map(() => '---').join('|')}|${B.map(() => '---').join('|')}|${B.map(() => '---').join('|')}|`)
for (const v of ['bm', 'mm-text', 'mm-text-nocase', 'mm-html', 'mm-html-fo', 'linux-mm-text']) {
  const list = rowsOf(v)
  const xs = (b) => list.map((id) => D[b].results[`${id}.${v}.final`]).filter((x) => x && typeof x.vsRef === 'number')
  const med = B.map((b) => median(xs(b).map((x) => x.vsRef)))
  const big = B.map((b) => { const bad = xs(b).filter((x) => x.vsRef > 2); return `${bad.length}/${xs(b).length}` })
  const inks = B.map((b) => `${median(xs(b).map((x) => x.ink))} / ${median(xs(b).map((x) => x.refInk))}`)
  p(`| ${v} | ${med.join(' | ')} | ${big.join(' | ')} | ${inks.join(' | ')} |`)
}
const caseFixed = rowsOf('mm-text').filter((id) => R['mm-text'][id].stripped?.caseFixed).length
p('', `Имя feDropShadow восстановлено в ${caseFixed} из ${rowsOf('mm-text').length} схем Mermaid (mm-text-nocase — тот же итог без восстановления).`)

// 5. Labels after DOMPurify
p('', '### Подписи после DOMPurify', '', '| Вариант | Схем | Все подписи видны | Подписей найдено |', '|---|---|---|---|')
for (const [label, v] of [['bm', 'bm'], ['Mermaid, htmlLabels: false', 'mm-text'], ['Mermaid, htmlLabels: true, SVG-профиль', 'mm-html'], ['Mermaid, htmlLabels: true, с foreignObject', 'mm-html-fo']]) {
  const list = rowsOf(v)
  const full = list.filter((id) => !R[v][id].finalRecall.missing.length).length
  const found = list.reduce((s, id) => s + R[v][id].finalRecall.found, 0), total = list.reduce((s, id) => s + R[v][id].finalRecall.total, 0)
  p(`| ${label} | ${list.length} | ${full} | ${frac(found, total)} |`)
}
const foRemoved = rowsOf('mm-html').map((id) => R['mm-html'][id].removed['<foreignobject>'] || 0)
const foText = rowsOf('mm-text').filter((id) => R['mm-text'][id].removed['<foreignobject>'])
p('', `SVG-профиль снял foreignObject в ${foRemoved.filter(Boolean).length} схемах с htmlLabels: true (всего ${foRemoved.reduce((a, b) => a + b, 0)} элементов). При htmlLabels: false foreignObject остался в ${foText.length}: ${foText.join(', ') || 'нет'}.`)

// 6. Safety scan
p('', '### Что несёт SVG до и после очистки', '', '| Вариант | Внешний адрес | @import | url() наружу | foreignObject | Скрипт или обработчик | javascript: | Чисто после очистки |', '|---|---|---|---|---|---|---|---|')
for (const [label, v] of [['bm', 'bm'], ['Mermaid text', 'mm-text'], ['Mermaid html', 'mm-html']]) {
  const list = rowsOf(v)
  const cnt = (k, key = 'rawScan') => list.filter((id) => R[v][id][key][k]).length
  p(`| ${label}, как отдал | ${cnt('externalUrl')} | ${cnt('import')} | ${cnt('externalCssUrl')} | ${cnt('foreignObject')} | ${list.filter((id) => R[v][id].rawScan.script || R[v][id].rawScan.handler).length} | ${cnt('jsUrl')} | — |`)
  p(`| ${label}, итог | ${cnt('externalUrl', 'finalScan')} | ${cnt('import', 'finalScan')} | ${cnt('externalCssUrl', 'finalScan')} | ${cnt('foreignObject', 'finalScan')} | ${list.filter((id) => R[v][id].finalScan.script || R[v][id].finalScan.handler).length} | ${cnt('jsUrl', 'finalScan')} | ${frac(list.filter((id) => R[v][id].finalClean).length, list.length)} |`)
}
p('', `Запросы из <img> во время показа: ${B.map((b) => `${b} — ${D[b].requests.length}`).join(', ')}. Те же SVG, вставленные в страницу как есть (эталон сверки): ${B.map((b) => `${b} — ${(D[b].inlineRequests || []).join(', ') || 'нет'}`).join('; ')}. Встроенный в страницу «сырой» SVG beautiful-mermaid запросил: ${(j.probes.bmInlineRaw?.requests || []).join(', ') || 'ничего'}; итог — ${(j.probes.bmInlineFinal?.requests || []).length} запросов.`)

// 7. Fonts
p('', '### Шрифты', '')
p('| Схема | Mermaid на macOS (Chromium) | Mermaid в образе apps/browser (Linux) | То же с Golos Text |', '|---|---|---|---|')
const f = (o) => (o && Object.keys(o).length ? Object.entries(o).sort((a, c) => c[1] - a[1]).map(([k]) => k).join(', ') : '—')
for (const id of Object.keys(j.fonts.linux)) p(`| ${id} | ${f(j.fonts.host[id])} | ${f(j.fonts.linux[id])} | ${f(j.fonts.linuxGolos[id])} |`)
p('', '| Вариант | ' + B.map((b) => `${b}: подписи за рамкой`).join(' | ') + ' | ' + B.map((b) => `${b}: шрифт текста`).join(' | ') + ' |', `|---|${B.map(() => '---').join('|')}|${B.map(() => '---').join('|')}|`)
for (const v of ['bm', 'bm-golos', 'mm-text', 'mm-text-golos', 'linux-mm-text', 'linux-mm-text-golos', 'mm-html-fo']) {
  const list = rowsOf(v)
  const over = B.map((b) => { let o = 0, c = 0; const where = []; for (const id of list) { const x = D[b].results[`${id}.${v}.final`]?.overflow; if (x && !x.error) { o += x.over; c += x.checked; if (x.over) where.push(id) } } return `${o}/${c}${where.length ? ` (${where.join(', ')})` : ''}` })
  const font = B.map((b) => { const fams = {}; for (const id of list) { const x = D[b].results[`${id}.${v}.final`]?.overflow?.font; if (x) fams[x] = (fams[x] || 0) + 1 } return Object.entries(fams).sort((a, c) => c[1] - a[1]).slice(0, 2).map(([k, n]) => `${k.replace(/"/g, '')} (${n})`).join('; ') })
  p(`| ${v} | ${over.join(' | ')} | ${font.join(' | ')} |`)
}
const clip = B.map((b) => { let c = 0, k = 0; const where = new Set(); for (const id of rowsOf('mm-html-fo')) { const x = D[b].results[`${id}.mm-html-fo.final`]?.overflow; if (x && !x.error) { c += x.foClipped || 0; k += x.foChecked || 0; if (x.foClipped) where.add(id) } } return `${b}: ${c}/${k}${where.size ? ` (${[...where].join(', ')})` : ''}` })
p('', `HTML-подписи (с foreignObject), текст больше своей рамки и обрезан: ${clip.join('; ')}.`)
p('', `Golos Text, 400 и 600, кириллица, латиница и latin-ext: ${j.golosEmbedBytes} байт woff2, ${j.golosCssBytes} байт CSS с base64 в каждом SVG.`)

// 8. Sizes
p('', '### Размер SVG', '', '| Вариант | Схем | Медиана, байт (как отдал) | Медиана, байт (итог) | Медиана, байт (итог, gzip) | Наибольший итог |', '|---|---|---|---|---|---|')
for (const v of ['bm', 'bm-golos', 'mm-text', 'mm-text-golos', 'mm-html-fo']) {
  const list = rowsOf(v)
  const a = list.map((id) => R[v][id].rawBytes), b = list.map((id) => R[v][id].finalBytes), g = list.map((id) => R[v][id].finalGzip)
  p(`| ${v} | ${list.length} | ${median(a)} | ${median(b)} | ${median(g)} | ${Math.max(...b)} |`)
}

// 9. Rough image difference
p('', '### Грубая разница картинок', '')
const dv = (k) => ids.map((id) => j.diffs[id]?.[k]).filter((x) => typeof x === 'number')
p(`- bm против Mermaid (миниатюры 48×48, 0–100): медиана ${median(dv('bmVsMm'))}, от ${Math.min(...dv('bmVsMm'))} до ${Math.max(...dv('bmVsMm'))} на ${dv('bmVsMm').length} схемах.`)
p(`- Mermaid с HTML-подписями (с foreignObject) против текстовых: медиана ${median(dv('htmlVsText'))}.`)
const lv = ids.map((id) => j.diffs[id]?.linuxVsHost).filter((x) => x != null)
p(`- Mermaid из образа Linux против macOS, одинаковый размер: ${lv.filter((x) => typeof x === 'number').length} из ${lv.length}, медиана разницы пикселей ${median(lv)} %.`)
for (const v of ['bm', 'bm-golos', 'mm-text', 'mm-text-golos', 'linux-mm-text-golos']) {
  const cells = ['webkit', 'firefox'].filter((b) => D[b]).map((b) => { const xs = ids.map((id) => j.diffs[id]?.cross?.[`${v}:${b}`]).filter((x) => x != null); const nums = xs.filter((x) => typeof x === 'number'); return `${b}: ${nums.length} из ${xs.length} того же размера, медиана ${median(nums)} %` })
  p(`- ${v}, Chromium против ${cells.join('; ')}.`)
}
const inl = (b, v) => median(ids.map((id) => D[b].results[`${id}.${v}.final`]?.imgVsInline))
p(`- <img> против того же SVG в странице (проверка метода): ${B.map((b) => `${b} — bm ${inl(b, 'bm')} %, Mermaid ${inl(b, 'mm-text')} %`).join('; ')}.`)

// 10. Hostile probes
p('', '### Враждебные пробы', '', '| Проба | bm | Mermaid strict | Mermaid strict + secure | Итог после очистки |', '|---|---|---|---|---|')
for (const [id, h] of Object.entries(j.probes)) {
  if (!/^H\d/.test(id)) continue
  const cell = (q) => {
    const bits0 = []
    if (!q) return '—'
    if (!q.ok) return q.timedOut ? `таймаут, убит за ${q.killMs ?? '—'} мс` : `отказ: ${short(q.error).slice(0, 40)}`
    if (q.ms != null && q.ms > 1000) bits0.push(`${Math.round(q.ms)} мс`)
    const bits = []
    if (q.pwnedDuringRender) bits.push(`скрипт сработал (${q.pwnedDuringRender})`)
    if (q.requestsDuringRender?.length) bits.push(`запросы: ${q.requestsDuringRender.length}`)
    const s = q.rawScan
    const raw = s ? Object.entries({ 'внешний адрес': s.externalUrl, '@import': s.import, 'url()': s.externalCssUrl, 'javascript:': s.jsUrl, 'обработчик': s.handler || s.script }).filter(([, x]) => x).map(([k]) => k) : []
    if (raw.length) bits.push(`в SVG: ${raw.join(', ')}`)
    if (q.inlineRaw?.pwned || q.inlineRaw?.requests?.length) bits.push(`в странице: ${q.inlineRaw.pwned ? 'скрипт' : ''}${q.inlineRaw.requests?.length ? ` ${q.inlineRaw.requests.length} запр.` : ''}`)
    return [...bits0, ...bits].join('; ') || 'чисто'
  }
  const finals = [h.bm, h['mm-default'], h['mm-locked']].filter((q) => q && q.ok)
  const clean = finals.every((q) => q.finalClean) && finals.every((q) => !q.inlineFinal?.pwned && !(q.inlineFinal?.requests || []).length)
  p(`| ${id} ${h.title} | ${cell(h.bm)} | ${cell(h['mm-default'])} | ${cell(h['mm-locked'])} | ${finals.length ? (clean ? 'чисто' : 'НЕ чисто') : '—'} |`)
}
const bl = j.probes.busyLoop
p('', `Бесконечный цикл в странице: страница не ответила за ${bl.waitedMs} мс, закрытие контекста — ${bl.killMs} мс, новая страница с Mermaid — ${bl.reopenMs} мс, рендер после неё — ${bl.renderAfterKill ? 'да' : 'нет'}.`)

// 11. Measurement
const res = new URL('./results.json', import.meta.url)
if (existsSync(res)) {
  const m = JSON.parse(readFileSync(res, 'utf8'))
  p('', `### Время и память${m.smoke ? ' (предварительно, один прогон)' : ''}`, '', `cold=${m.params.cold}, warm=${m.params.warm}. ${m.started.uptime}`, '')
  const s = m.summary
  p('| Движок | Нарисовано | Холодный | Тёплый (медиана медиан / худший p95) | Память |', '|---|---|---|---|---|')
  p(`| beautiful-mermaid | ${s.bm.ok}/30 | import ${s.bm.coldImportMs} мс + первый рендер ${s.bm.coldRenderMs} мс (процесс целиком ${s.bm.coldProcessMs} мс) | ${s.bm.warmMedianOfMedians} / ${s.bm.warmMaxP95} мс | пустой Node ${s.bm.nodeBaselineRssMiB ?? '—'} МиБ RSS, после import и одного рендера ${s.bm.rssAfterImportMiB} МиБ |`)
  p(`| Mermaid | ${s.mm.ok}/30 | запуск Chromium ${s.mm.browserLaunchMs} мс; страница + Mermaid ${s.mm.coldPrepMs} мс + первый рендер ${s.mm.coldRenderMs} мс | ${s.mm.warmMedianOfMedians} / ${s.mm.warmMaxP95} мс | Chromium: пустой ${s.mm.browserIdleRssMiB} МиБ, со страницей ${s.mm.chromiumRssAfterLoadMiB} МиБ, пик ${s.mm.chromiumRssPeakMiB} МиБ; куча страницы ${s.mm.pageHeapAfterLoadMiB} → ${s.mm.pageHeapAfterWarmMiB} МиБ |`)
  p(`| DOMPurify + jsdom | — | — | bm ${s.sanitize.bmMedian} мс, Mermaid ${s.sanitize.mmMedian} мс | — |`)
}
console.log(out.join('\n'))
