// The `artifact_layout` result prototype (spike s3 of plan 88, Ар32): a short English text for the
// model — it lands in the expensive main context of the turn — and one Russian line for «Ход
// работы». Page text appears only as short quoted snippets: it is data of the artifact, not words
// of the client, and may be written by another person.

const LIMIT = 1500

/** Merge the findings of both widths into one list; the probe's events become findings too. */
export function findingsOf(byWidth) {
  const all = []
  for (const [width, r] of Object.entries(byWidth)) {
    const w = Number(width)
    const issues = [...((r.map && r.map.issues) || []), ...((r.pixels && r.pixels.issues) || [])]
    for (const i of issues) all.push({ ...i, w })
    const ev = r.events || {}
    for (const e of ev.pageErrors || []) all.push({ kind: 'script-error', text: e, w })
    for (const e of ev.consoleErrors || []) all.push({ kind: 'console-error', text: e, w })
    for (const c of ev.csp || []) if (c.url) all.push({ kind: 'blocked', url: c.url, what: c.kind, directive: c.directive, w })
    for (const b of ev.blocked || []) if (!b.navigation) all.push({ kind: 'blocked', url: b.url, what: b.type, w })
    for (const u of ev.navigations || []) all.push({ kind: 'navigates', url: u, w })
    if (r.hung) all.push({ kind: 'hung', w })
    else if (r.settle && !r.settle.settled) all.push({ kind: 'unsettled', w })
    if (r.error) all.push({ kind: 'render-failed', text: r.error, w })
    if (r.map && r.map.photo && r.map.photo.length && !r.pixels) all.push({ kind: 'photo-text', count: r.map.photo.length, w })
  }
  return all
}

const SEVERITY = ['render-failed', 'hung', 'script-error', 'navigates', 'blocked', 'font-missing', 'font-failed', 'broken-img', 'hscroll', 'cut', 'overlap', 'clipped', 'contrast-hard', 'small-text', 'empty', 'invisible', 'contrast', 'console-error', 'tap-small', 'no-viewport', 'unsettled', 'photo-text']
const severity = (f) => SEVERITY.indexOf(f.kind === 'contrast' && f.ratio < 3 ? 'contrast-hard' : f.kind)

// What makes two findings the same across widths, and same-looking ones inside one width.
const keyOf = (f) => {
  switch (f.kind) {
    case 'hscroll': case 'cut': return `${f.kind}|${(f.culprits || []).map((c) => c.id).join(',')}`
    case 'contrast': return `contrast|${f.id}|${f.fg}|${f.bg}`
    case 'small-text': return `small|${f.id}|${f.px}`
    case 'overlap': return `overlap|${f.id}|${f.under && f.under.id}`
    case 'clipped': return `clipped|${f.id}|${f.axis}`
    case 'empty': return `empty|${f.id}`
    case 'blocked': return `blocked|${f.url}`
    case 'navigates': return `navigates|${f.url}`
    case 'script-error': case 'console-error': case 'render-failed': return `${f.kind}|${f.text}`
    case 'font-missing': case 'font-failed': return `${f.kind}|${f.family}`
    case 'broken-img': return `img|${f.id}`
    default: return `${f.kind}|${f.id || ''}`
  }
}
const familyOf = (f) => {
  switch (f.kind) {
    case 'contrast': return `contrast|${f.tag}|${f.fg}|${f.bg}`
    case 'small-text': return `small|${f.tag}|${f.px}`
    case 'clipped': return f.axis === 'ancestor' ? `clipped-by|${f.by && f.by.id}` : `clipped|${f.tag}`
    case 'overlap': return `overlap|${f.tag}`
    default: return null
  }
}

const clean = (text, n = 32) => {
  const t = String(text || '').replace(/«/g, '„').replace(/»/g, '“').replace(/[\u0000-\u001f<>`]/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
const el = (f) => `${f.id || '?'} <${f.tag || 'element'}>`
const quote = (t) => (t ? ` «${clean(t)}»` : '')
const widths = (ws) => (ws.length > 1 ? 'both' : String(ws[0]))

function line(f, ws, same) {
  const at = `${widths(ws)}: `
  const also = same.length ? `; same in ${same.slice(0, 3).join(', ')}${same.length > 3 ? ` and ${same.length - 3} more` : ''}` : ''
  switch (f.kind) {
    case 'render-failed': return `${at}the frame was not drawn: ${clean(f.text, 80)}.`
    case 'hung': return `${at}a script of the frame did not finish in time; it was stopped and the frame drawn as it stood.`
    case 'unsettled': return `${at}the frame kept changing for 1 s (an animation or a timer); it was drawn mid-way.`
    case 'script-error': return `${at}script error — ${clean(f.text, 84)}. The frame is sandboxed: no storage, cookies, network or pop-ups.`
    case 'console-error': return `${at}console error — ${clean(f.text, 90)}.`
    case 'navigates': return `${at}the frame tries to leave its page for ${clean(f.url, 60)} (a link, a form, a refresh or a script); the client would see that page instead.`
    case 'blocked': {
      const all = [f, ...(f.more || [])]
      const urls = all.slice(0, 3).map((x) => `${x.what || 'load'} ${clean(x.url, 56)}`).join('; ')
      return `${at}blocked ${all.length > 1 ? `${all.length} loads: ` : ''}${urls}${all.length > 3 ? ` and ${all.length - 3} more` : ''} — a frame loads nothing from outside; use the platform fonts and artifact files.`
    }
    case 'font-missing': return `${at}font «${clean(f.family, 30)}» is not available (${f.blocks} blocks fall back to another font).`
    case 'font-failed': return `${at}font «${clean(f.family, 30)}» failed to load.`
    case 'broken-img': return `${at}picture ${el(f)} does not draw (${clean(f.src, 30)}).`
    case 'hscroll':
    case 'cut': {
      const c = (f.culprits || []).slice(0, 2).map((x) => `${el(x)} ${x.width} px${x.why ? ` (${clean(x.why, 44)})` : ''}`).join('; ')
      return `${at}${f.kind === 'cut' ? 'content is cut at the right edge' : 'the page scrolls sideways'} by ${f.by} px. Wider than the screen: ${c || 'unknown'}${f.more ? ` and ${f.more} more` : ''}.`
    }
    case 'overlap': return `${at}${el(f)}${quote(f.text)} covers text of ${el(f.under)}${quote(f.under.text)} (${f.ow}×${f.oh} px)${also}.`
    case 'clipped': return f.axis === 'ancestor'
      ? `${at}text of ${el(f)}${quote(f.text)} is cut by ${el(f.by)} (overflow hidden)${also}.`
      : `${at}text of ${el(f)}${quote(f.text)} is cut: needs ${f.need} px, has ${f.has} px${also}.`
    case 'contrast': return f.photo
      ? `${at}low contrast on a picture — ${el(f)}${quote(f.text)} reaches ${f.ratio}:1 over 90 % of its background (needs ${f.need})${also}.`
      : `${at}low contrast ${f.ratio}${f.upto ? `–${f.upto}` : ''}:1 (needs ${f.need}) — ${el(f)}${quote(f.text)} ${f.fg} on ${f.gradient ? 'gradient ' : ''}${f.bg}${also}.`
    case 'small-text': return `${at}small text ${f.px} px — ${el(f)}${quote(f.text)}${also}.`
    case 'empty': return `${at}empty area ${f.h} px tall at y ${f.y}${f.id ? ` in ${el(f)}${f.emptyBox ? ' (an empty box)' : ''}` : ''}.`
    case 'invisible': return `${at}${f.blocks} blocks with text stay transparent until a script shows them (${(f.first || []).map((x) => el(x)).join(', ')}): PNG, PDF and thumbnails show them empty.`
    case 'tap-small': return `${at}${f.count} touch target${f.count === 1 ? '' : 's'} smaller than 24 px: ${(f.first || []).map((x) => `${el(x)} ${x.tw}×${x.th}`).join(', ')}.`
    case 'no-viewport': return `${at}no <meta name="viewport" content="width=device-width">: a phone will show the published page zoomed out.`
    case 'photo-text': return `${at}${f.count} text blocks lie on pictures; contrast there was not measured.`
    default: return `${at}${f.kind}.`
  }
}

/** The English report for the model and the Russian line for «Ход работы». */
export function layoutReport({ name, title, byWidth, detail = false }) {
  const findings = findingsOf(byWidth)
  // One finding per key, with every width it was seen at.
  const merged = new Map()
  for (const f of findings) {
    const k = keyOf(f)
    const prev = merged.get(k)
    if (prev) { if (!prev.ws.includes(f.w)) prev.ws.push(f.w) } else merged.set(k, { f, ws: [f.w] })
  }
  // Same-looking findings (one style on several elements) become one line.
  const families = new Map()
  const lines = []
  for (const { f, ws } of merged.values()) {
    const fam = familyOf(f)
    const famKey = fam ? `${fam}|${widths(ws.sort())}` : null
    if (famKey && families.has(famKey)) { families.get(famKey).same.push(f.id || '?'); continue }
    const entry = { f, ws: ws.sort((a, b) => b - a), same: [] }
    if (famKey) families.set(famKey, entry)
    lines.push(entry)
  }
  // Every load from outside goes in one line: the cause is the same.
  const blocked = lines.filter((l) => l.f.kind === 'blocked')
  if (blocked.length > 1) {
    const first = blocked[0]
    first.f = { ...first.f, more: blocked.slice(1).map((l) => l.f) }
    first.ws = [...new Set(blocked.flatMap((l) => l.ws))].sort((a, b) => b - a)
    for (const l of blocked.slice(1)) lines.splice(lines.indexOf(l), 1)
  }
  lines.sort((a, b) => severity(a.f) - severity(b.f))
  const sizes = Object.entries(byWidth).map(([w, r]) => (r.map ? `${w}×${r.map.doc.docH}` : `${w}: not drawn`)).join(', ')
  const head = `Layout of «${clean(title || name, 48)}» as the client sees it (${sizes}).`
  const problems = lines.filter((l) => !['unsettled', 'photo-text', 'console-error'].includes(l.f.kind))
  const checked = new Set(findings.map((f) => f.kind))
  const ok = [
    ['script-error', 'scripts'], ['blocked', 'loads'], ['font-missing', 'fonts'], ['hscroll', 'width'], ['overlap', 'overlaps'],
    ['clipped', 'cut text'], ['contrast', 'contrast'], ['small-text', 'text size'], ['empty', 'empty areas'], ['broken-img', 'pictures'],
  ].filter(([k]) => !checked.has(k) && !(k === 'hscroll' && checked.has('cut'))).map(([, w]) => w)
  const body = []
  let length = head.length
  let dropped = 0
  const footer = ok.length ? `OK: ${ok.join(', ')}.` : ''
  const NOTES = ['unsettled', 'photo-text', 'console-error']
  for (const l of [...lines.filter((x) => !NOTES.includes(x.f.kind)), ...lines.filter((x) => NOTES.includes(x.f.kind))]) {
    const text = `${NOTES.includes(l.f.kind) ? 'Note' : '-'} ${line(l.f, l.ws, l.same)}`
    if (!detail && length + text.length + footer.length + 60 > LIMIT) { dropped++; continue }
    body.push(text)
    length += text.length + 1
  }
  const summary = problems.length ? `${problems.length} problem${problems.length === 1 ? '' : 's'}, most serious first:` : 'No problems found.'
  const text = [head, summary, ...body, dropped ? `(+${dropped} more; ask artifact_layout with detail: true)` : '', footer].filter(Boolean).join('\n')
  return { text, chars: text.length, problems: problems.length, ru: russianLine(title || name, problems), lines }
}

const RU = {
  'render-failed': 'кадр не отрисовался', hung: 'скрипт кадра зависал', 'script-error': 'ошибка в скрипте', navigates: 'кадр уходит на другую страницу', blocked: 'внешние файлы не загружаются',
  'font-missing': 'нет шрифта', 'font-failed': 'шрифт не загрузился', 'broken-img': 'картинка не показывается', hscroll: 'на телефоне страница шире экрана',
  cut: 'содержимое обрезано справа', overlap: 'блоки наезжают друг на друга', clipped: 'текст обрезан', contrast: 'низкий контраст текста',
  'small-text': 'мелкий текст', empty: 'большое пустое место', invisible: 'блоки видны только после прокрутки', 'tap-small': 'мелкие кнопки на телефоне',
  'no-viewport': 'нет настройки страницы для телефона',
}
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many)

function russianLine(title, problems) {
  const name = clean(title, 40)
  if (!problems.length) return `Проверка вёрстки «${name}» на компьютере и телефоне: замечаний нет`
  const kinds = []
  for (const l of problems) {
    const word = l.f.kind === 'hscroll' && !l.ws.includes(390) ? 'страница шире экрана' : RU[l.f.kind]
    if (word && !kinds.includes(word)) kinds.push(word)
  }
  const n = problems.length
  return `Проверка вёрстки «${name}» на компьютере и телефоне: ${n} ${plural(n, 'замечание', 'замечания', 'замечаний')} — ${kinds.slice(0, 3).join(', ')}${kinds.length > 3 ? ' и другое' : ''}`
}
