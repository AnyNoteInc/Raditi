// Spike s4 of plan 88: does canonical Markdown survive the editor? Runs every construct, every
// corpus document (whole and by sections), the editor-made cases, a one-word edit and the quote
// check through each bridge, and writes results/*.json and results/summary.md.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { canonPlan, canonFixed } from './lib/canon.mjs'
import { editorOf, loadMarkdown, loadHtml, loadJson, saveMarkdown, withoutIds, destroyAll } from './lib/tiptap.mjs'
import { mdToPm, pmToMd, canonBridge } from './lib/remark-bridge.mjs'
import { classify, visibleText, quoteText, lineDiff, wordDiff, show, severity } from './lib/compare.mjs'
import { constructs } from './constructs.mjs'
import { editorCases } from './editor-cases.mjs'

const here = new URL('.', import.meta.url).pathname
const MARKERS = { '⍽': ' ', '⎵': ' ' }
const decode = (s) => s.replace(/[⍽⎵]/g, (m) => MARKERS[m])

/** The bridges: an extension set, a way in and out, and the canonical profile on the server. */
export const bridges = {
  'tiptap·stock·plan': { set: 'stock', kind: 'tiptap', canon: canonPlan },
  'tiptap·stock·fixed': { set: 'stock', kind: 'tiptap', canon: canonFixed },
  'tiptap·tuned·plan': { set: 'tuned', kind: 'tiptap', canon: canonPlan },
  'tiptap·tuned·fixed': { set: 'tuned', kind: 'tiptap', canon: canonFixed },
  'remark·plan': { set: 'bridge', kind: 'remark', canon: canonPlan },
  'remark·fixed': { set: 'bridge', kind: 'remark', canon: canonFixed },
  'remark·bridge': { set: 'bridge', kind: 'remark', canon: canonBridge },
}
const MAIN = ['tiptap·stock·plan', 'tiptap·tuned·fixed', 'remark·bridge']
const PROFILES = { plan: canonPlan, fixed: canonFixed, bridge: canonBridge }

/** Markdown into the editor: the document the person sees. */
function load(bridge, markdown) {
  const editor = editorOf(bridge.set)
  if (bridge.kind === 'tiptap') return { editor, doc: loadMarkdown(editor, markdown) }
  return { editor, doc: loadJson(editor, mdToPm(markdown)) }
}

/** The editor's document out as Markdown, then canonicalized as the server would. */
function save(bridge, editor) {
  const out = bridge.kind === 'tiptap' ? saveMarkdown(editor) : pmToMd(editor.getJSON())
  return { out, canonical: bridge.canon(out) }
}

function roundTrip(bridge, a) {
  const { editor, doc } = load(bridge, a)
  const { out, canonical } = save(bridge, editor)
  return { doc: withoutIds(doc), out, c: canonical }
}

function evaluate(bridgeName, raw) {
  const bridge = bridges[bridgeName]
  let a
  try {
    a = bridge.canon(raw)
    const first = roundTrip(bridge, a)
    const second = roundTrip(bridge, first.c)
    return {
      cls: classify(a, first.c),
      idempotent: second.c === first.c,
      editorStable: isDeepStrictEqual(first.doc, second.doc),
      visibleSame: visibleText(a) === visibleText(first.c),
      a,
      out: first.out,
      c: first.c,
      c2: second.c,
      changedLines: lineDiff(a, first.c, 1e9).length,
    }
  } catch (error) {
    return { cls: 'crash', error: String(error?.message ?? error).slice(0, 300), a }
  }
}

const mark = (r) => {
  const base = { same: '=', cosmetic: '~', format: 'F', words: 'W', crash: 'X' }[r.cls]
  return base + (r.cls !== 'crash' && !r.idempotent ? '²' : '') + (r.cls !== 'crash' && !r.editorStable ? 'ᵉ' : '')
}

// ---------- constructs ----------
const constructResults = constructs.map(([id, group, md]) => {
  const results = Object.fromEntries(Object.keys(bridges).map((b) => [b, evaluate(b, md)]))
  return { id, group, raw: md, results }
})

// ---------- corpus ----------
const corpusDir = here + 'corpus/'
const corpus = readdirSync(corpusDir)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => ({ name: f, text: decode(readFileSync(corpusDir + f, 'utf8')) }))

/** A document by its sections, as the agent writes them: the body under each `## heading`. */
function sectionsOf(text) {
  const parts = text.split(/^## .*$/m)
  return parts.slice(1).map((body) => body.trim() + '\n').filter((body) => body.trim())
}

const corpusResults = corpus.map(({ name, text }) => {
  const whole = Object.fromEntries(Object.keys(bridges).map((b) => [b, evaluate(b, text)]))
  const sections = sectionsOf(text)
  const bySection = Object.fromEntries(
    Object.keys(bridges).map((b) => {
      const rs = sections.map((s) => evaluate(b, s))
      return [
        b,
        {
          count: rs.length,
          same: rs.filter((r) => r.cls === 'same').length,
          worst: rs.reduce((w, r) => (severity[r.cls] > severity[w] ? r.cls : w), 'same'),
          idempotent: rs.every((r) => r.cls === 'crash' || r.idempotent),
          visibleSame: rs.every((r) => r.visibleSame),
          classes: rs.map((r) => r.cls),
        },
      ]
    }),
  )
  return { name, bytes: Buffer.byteLength(text), sections: sections.length, whole, bySection }
})

// ---------- edits by a person ----------
/**
 * Four edits a person makes, each on a fresh load of A: replace a word of a paragraph, make a word
 * of a paragraph bold, add words at the end of a list item, replace a word in a table cell. An edit
 * passes when the canonical text after it differs from A in exactly one line, and that line is the
 * edited one with the expected change.
 */
const EDITS = {
  word: { where: ['paragraph'], change: (editor, t) => editor.chain().insertContentAt({ from: t.from, to: t.to }, 'ПРАВКА').run(), expect: (line, t) => line.replace(t.word, 'ПРАВКА') },
  bold: { where: ['paragraph'], change: (editor, t) => editor.chain().setTextSelection({ from: t.from, to: t.to }).setBold().run(), expect: (line, t) => line.replace(t.word, `**${t.word}**`) },
  listItem: { where: ['listItem', 'taskItem'], change: (editor, t) => editor.chain().insertContentAt(t.end, ' и ещё').run(), expect: (line) => line + ' и ещё' },
  cell: { where: ['tableCell'], change: (editor, t) => editor.chain().insertContentAt({ from: t.from, to: t.to }, 'ПРАВКА').run(), expect: (line, t) => line.replace(t.word, 'ПРАВКА') },
}

function targetOf(editor, where) {
  let target = null
  editor.state.doc.descendants((node, pos) => {
    if (target) return false
    if (!node.isTextblock || node.type.name !== 'paragraph') return true
    const $pos = editor.state.doc.resolve(pos)
    const holder = $pos.parent.type.name
    if (!where.includes(holder === 'doc' ? 'paragraph' : holder)) return true
    if (holder === 'doc' || ['tableCell', 'listItem', 'taskItem'].includes(holder)) {
      let offset = 0
      for (let i = 0; i < node.childCount; i += 1) {
        const child = node.child(i)
        if (child.isText && !child.marks.length && !target) {
          const m = /[А-Яа-яЁё]{4,}/u.exec(child.text)
          if (m) target = { from: pos + 1 + offset + m.index, to: pos + 1 + offset + m.index + m[0].length, word: m[0], end: pos + 1 + node.content.size }
        }
        offset += child.nodeSize
      }
      // a list item: only its first paragraph without marks at the end
      if (target && holder !== 'doc' && holder !== 'tableCell' && node.lastChild?.marks.length) target = null
    }
    return !target
  })
  return target
}

function personEdit(bridgeName, raw, kind) {
  const bridge = bridges[bridgeName]
  const edit = EDITS[kind]
  const a = bridge.canon(raw)
  const { editor } = load(bridge, a)
  const target = targetOf(editor, edit.where)
  if (!target) return null
  edit.change(editor, target)
  const { canonical } = save(bridge, editor)
  const diff = lineDiff(a, canonical, 1e9)
  const removed = diff.filter((l) => l.startsWith('-')).map((l) => l.slice(2))
  const added = diff.filter((l) => l.startsWith('+')).map((l) => l.slice(2))
  return {
    word: target.word,
    onlyThat: removed.length === 1 && added.length === 1 && added[0] === edit.expect(removed[0], target),
    changedLines: added.length,
    diff: diff.slice(0, 12),
  }
}

const editResults = corpus.map(({ name, text }) => ({
  name,
  results: Object.fromEntries(MAIN.map((b) => [b, Object.fromEntries(Object.keys(EDITS).map((k) => [k, personEdit(b, text, k)]))])),
}))

// ---------- quotes of the agent ----------
/** Lines the agent wrote, as fragments it would quote in `edit`: its own words, markup and all. */
function quotesOf(raw) {
  return raw
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s?/, '')
        .replace(/(?:\\| {2,})$/, '') // a hard break at the end of the line is no part of the words
        .trim(),
    )
    .filter((line) => line.length >= 12 && !line.startsWith('|') && !/^```|^~~~|^\[\^?[^\]]+\]:/.test(line))
}

/** Link definitions of a document: a quote with `[x][ref]` reads the same with them. */
const definitionsOf = (md) => md.split('\n').filter((l) => /^\[[^\]^][^\]]*\]:\s/.test(l)).join('\n')

function quoteCheck(quotesFrom, target) {
  const defs = definitionsOf(quotesFrom)
  const visible = quoteText(target)
  const r = { quotes: 0, bySource: 0, byVisible: 0, eitherWay: 0, misses: [] }
  for (const q of quotesOf(quotesFrom)) {
    // A footnote call out of its document is literal text: the words are matched without it.
    const v = quoteText(q.replace(/\[\^[^\]]+\]/g, '') + (defs ? '\n\n' + defs : ''))
    if (!v) continue // an HTML comment or tag alone: nothing to quote by sight
    r.quotes += 1
    const s = target.includes(q)
    const w = visible.includes(v)
    if (s) r.bySource += 1
    if (w) r.byVisible += 1
    if (s || w) r.eitherWay += 1
    else if (r.misses.length < 3) r.misses.push(q.slice(0, 80))
  }
  return r
}

const quoteResults = corpus.map(({ name, text }) => {
  const row = { name }
  for (const [profile, canon] of Object.entries(PROFILES)) row[`raw→${profile}`] = quoteCheck(text, canon(text))
  for (const b of MAIN) {
    const r = evaluate(b, text)
    row[`A→C ${b}`] = r.c ? quoteCheck(r.a, r.c) : null
  }
  return row
})

// ---------- what canonicalization does to the agent's own text ----------
const canonResults = corpus.map(({ name, text }) => {
  const row = { name }
  for (const [profile, canon] of Object.entries(PROFILES)) {
    const a = canon(text)
    row[profile] = {
      changedLines: lineDiff(text.endsWith('\n') ? text : text + '\n', a, 1e9).filter((l) => l.startsWith('+')).length,
      visibleSame: visibleText(text) === visibleText(a),
      words: visibleText(text) === visibleText(a) ? [] : wordDiff(visibleText(text), visibleText(a)).map(show),
      idempotent: canon(a) === a,
    }
  }
  return row
})

// ---------- editor-made content ----------
function editorCase(bridgeName, input) {
  const bridge = bridges[bridgeName]
  const editor = editorOf(bridge.set)
  try {
    const doc1 = withoutIds(input.html !== undefined ? loadHtml(editor, input.html) : loadJson(editor, input.json))
    const { out, canonical } = save(bridge, editor)
    const doc2 = withoutIds(load(bridge, canonical).doc)
    const { canonical: again } = save(bridge, editor)
    return {
      stable: isDeepStrictEqual(doc1, doc2),
      idempotent: again === canonical,
      out,
      c: canonical,
      doc1,
      doc2,
    }
  } catch (error) {
    return { crash: String(error?.message ?? error).slice(0, 300) }
  }
}

const editorResults = editorCases.map(([id, title, input]) => ({
  id,
  title,
  results: Object.fromEntries(Object.keys(bridges).map((b) => [b, editorCase(b, input)])),
}))

destroyAll()

// ---------- write ----------
mkdirSync(here + 'results', { recursive: true })
writeFileSync(here + 'results/constructs.json', JSON.stringify(constructResults, null, 1))
writeFileSync(here + 'results/corpus.json', JSON.stringify(corpusResults, null, 1))
writeFileSync(here + 'results/edits.json', JSON.stringify(editResults, null, 1))
writeFileSync(here + 'results/quotes.json', JSON.stringify(quoteResults, null, 1))
writeFileSync(here + 'results/canon.json', JSON.stringify(canonResults, null, 1))
writeFileSync(here + 'results/editor.json', JSON.stringify(editorResults, null, 1))

// ---------- summary ----------
const lines = []
const names = Object.keys(bridges)
lines.push('# Сводка прогона', '', `Конструкций: ${constructs.length}; документов: ${corpus.length}; случаев правки: ${editorCases.length}.`, '')
lines.push('## Конструкции', '', '`=` то же, `~` только вид исходника, `F` другое HTML при тех же словах, `W` другие видимые слова, `X` сбой; `²` второй круг не равен первому; `ᵉ` документ в редакторе после круга другой.', '')
lines.push(`| Конструкция | ${names.join(' | ')} |`, `|---|${names.map(() => ':-:').join('|')}|`)
for (const c of constructResults) lines.push(`| ${c.id} | ${names.map((b) => mark(c.results[b])).join(' | ')} |`)
const tally = (rs) => {
  const t = { same: 0, cosmetic: 0, format: 0, words: 0, crash: 0, notIdem: 0, notStable: 0, notVisible: 0 }
  for (const r of rs) {
    t[r.cls] += 1
    if (r.cls !== 'crash' && !r.idempotent) t.notIdem += 1
    if (r.cls !== 'crash' && !r.editorStable) t.notStable += 1
    if (r.cls !== 'crash' && !r.visibleSame) t.notVisible += 1
  }
  return t
}
lines.push('', '### Итого по конструкциям', '', '| Мост | = | ~ | F | W | X | ² | ᵉ | видимый текст другой |', '|---|--:|--:|--:|--:|--:|--:|--:|--:|')
for (const b of names) {
  const t = tally(constructResults.map((c) => c.results[b]))
  lines.push(`| ${b} | ${t.same} | ${t.cosmetic} | ${t.format} | ${t.words} | ${t.crash} | ${t.notIdem} | ${t.notStable} | ${t.notVisible} |`)
}

lines.push('', '## Документы целиком', '', `| Документ | ${names.join(' | ')} |`, `|---|${names.map(() => ':-:').join('|')}|`)
for (const d of corpusResults) lines.push(`| ${d.name} | ${names.map((b) => mark(d.whole[b]) + ` ${d.whole[b].changedLines ?? ''}`).join(' | ')} |`)
lines.push('', '### Итого по документам целиком', '', '| Мост | = | ~ | F | W | X | ² | ᵉ | видимый текст другой |', '|---|--:|--:|--:|--:|--:|--:|--:|--:|')
for (const b of names) {
  const t = tally(corpusResults.map((d) => d.whole[b]))
  lines.push(`| ${b} | ${t.same} | ${t.cosmetic} | ${t.format} | ${t.words} | ${t.crash} | ${t.notIdem} | ${t.notStable} | ${t.notVisible} |`)
}
lines.push('', '### Разделы', '', '| Мост | разделов | без изменений | худшее | второй круг равен первому | видимый текст тот же |', '|---|--:|--:|---|--:|--:|')
for (const b of names) {
  let count = 0
  let same = 0
  let idem = 0
  let vis = 0
  const worst = { same: 0, cosmetic: 0, format: 0, words: 0, crash: 0 }
  for (const d of corpusResults) {
    const s = d.bySection[b]
    count += s.count
    same += s.same
    for (const c of s.classes) worst[c] += 1
    if (s.idempotent) idem += 1
    if (s.visibleSame) vis += 1
  }
  lines.push(`| ${b} | ${count} | ${same} | ~${worst.cosmetic} F${worst.format} W${worst.words} X${worst.crash} | ${idem}/${corpusResults.length} док. | ${vis}/${corpusResults.length} док. |`)
}

lines.push('', '## Правки человека', '', 'Правка проходит, когда канонический текст после неё отличается от A ровно одной строкой — той, что правили, и так, как правили.', '')
lines.push(`| Правка | ${MAIN.map((b) => `${b}: прошла / была`).join(' | ')} |`, `|---|${MAIN.map(() => '--:').join('|')}|`)
for (const k of Object.keys(EDITS)) {
  lines.push(`| ${k} | ${MAIN.map((b) => { const rs = editResults.map((e) => e.results[b][k]).filter(Boolean); return `${rs.filter((r) => r.onlyThat).length} / ${rs.length}` }).join(' | ')} |`)
}
lines.push('', '| Документ | ' + MAIN.map((b) => b).join(' | ') + ' |', `|---|${MAIN.map(() => ':-:').join('|')}|`)
for (const e of editResults)
  lines.push(`| ${e.name} | ${MAIN.map((b) => Object.entries(e.results[b]).map(([k, r]) => (r ? (r.onlyThat ? '✓' : `✗${r.changedLines}`) : '·')).join(' ')).join(' | ')} |`)
lines.push('', 'Порядок значков: word, bold, listItem, cell; `✓` — только правленая строка, `✗N` — изменилось N строк, `·` — места для правки нет.')

lines.push('', '## Цитаты агента', '', 'Строка, которую агент написал (или прочитал в A), как цитата для `edit`: найдена ли она в целевом тексте по исходнику и по видимому тексту (сноски и разметка не считаются).', '')
const qcols = Object.keys(quoteResults[0]).filter((k) => k !== 'name')
lines.push(`| Что с чем | цитат | по исходнику | по видимому | хоть как-то |`, '|---|--:|--:|--:|--:|')
for (const col of qcols) {
  const t = { q: 0, s: 0, v: 0, e: 0 }
  for (const row of quoteResults) {
    const r = row[col]
    if (!r) continue
    t.q += r.quotes
    t.s += r.bySource
    t.v += r.byVisible
    t.e += r.eitherWay
  }
  lines.push(`| ${col} | ${t.q} | ${t.s} | ${t.v} | ${t.e} |`)
}

lines.push('', '## Что канонизация делает с текстом агента', '', '| Документ | plan: строк | fixed: строк | bridge: строк | видимый текст другой |', '|---|--:|--:|--:|---|')
for (const r of canonResults)
  lines.push(`| ${r.name} | ${r.plan.changedLines} | ${r.fixed.changedLines} | ${r.bridge.changedLines} | ${Object.entries(r).filter(([k, v]) => k !== 'name' && !v.visibleSame).map(([k, v]) => `${k}: ${v.words.slice(0, 4).join(' ')}`).join('; ') || '—'} |`)
const ct = (p) => canonResults.reduce((n, r) => n + r[p].changedLines, 0)
lines.push(`| **Итого** | ${ct('plan')} | ${ct('fixed')} | ${ct('bridge')} | |`)
lines.push('', `Канон идемпотентен: plan ${canonResults.filter((r) => r.plan.idempotent).length}/30, fixed ${canonResults.filter((r) => r.fixed.idempotent).length}/30, bridge ${canonResults.filter((r) => r.bridge.idempotent).length}/30.`)

lines.push('', '## Правки в редакторе', '', '`=` документ редактора после круга тот же и второй круг равен первому; `≠` документ другой; `²` второй круг другой; `X` сбой.', '')
lines.push(`| Случай | ${names.join(' | ')} |`, `|---|${names.map(() => ':-:').join('|')}|`)
for (const e of editorResults)
  lines.push(`| ${e.id} | ${names.map((b) => { const r = e.results[b]; return r.crash ? 'X' : (r.stable ? '=' : '≠') + (r.idempotent ? '' : '²') }).join(' | ')} |`)

writeFileSync(here + 'results/summary.md', lines.join('\n') + '\n')

// ---------- details of what changed (main bridges), for the report ----------
const details = ['# Что меняется: конструкции', '']
for (const c of constructResults) {
  for (const b of MAIN) {
    const r = c.results[b]
    if (r.cls === 'same' && r.idempotent && r.editorStable) continue
    details.push(`## ${c.id} · ${b} · ${mark(r)}`, '')
    if (r.cls === 'crash') {
      details.push('```text', r.error, '```', '')
      continue
    }
    details.push('A:', '```text', show(r.a).trimEnd(), '```', 'Tiptap/мост отдал:', '```text', show(r.out ?? '').trimEnd(), '```', 'C:', '```text', show(r.c).trimEnd(), '```')
    if (!r.idempotent) details.push('C после второго круга:', '```text', show(r.c2).trimEnd(), '```')
    if (!r.visibleSame) details.push('Видимые слова: ' + wordDiff(visibleText(r.a), visibleText(r.c)).map(show).join(' '))
    details.push('')
  }
}
writeFileSync(here + 'results/details-constructs.md', details.join('\n') + '\n')

const corpusDetails = ['# Что меняется: документы целиком', '']
for (const d of corpusResults) {
  for (const b of MAIN) {
    const r = d.whole[b]
    if (r.cls === 'same' && r.idempotent) continue
    corpusDetails.push(`## ${d.name} · ${b} · ${mark(r)}`, '')
    if (r.cls === 'crash') {
      corpusDetails.push('```text', r.error, '```', '')
      continue
    }
    corpusDetails.push('```diff', ...lineDiff(r.a, r.c, 40).map(show), '```')
    if (!r.visibleSame) corpusDetails.push('Видимые слова: ' + wordDiff(visibleText(r.a), visibleText(r.c)).map(show).join(' '))
    corpusDetails.push('')
  }
}
writeFileSync(here + 'results/details-corpus.md', corpusDetails.join('\n') + '\n')

const editorDetails = ['# Что меняется: правки в редакторе', '']
for (const e of editorResults) {
  for (const b of MAIN) {
    const r = e.results[b]
    if (!r.crash && r.stable && r.idempotent) continue
    editorDetails.push(`## ${e.id} — ${e.title} · ${b}`, '')
    if (r.crash) {
      editorDetails.push('```text', r.crash, '```', '')
      continue
    }
    editorDetails.push('Отдал:', '```text', show(r.out).trimEnd(), '```', 'C:', '```text', show(r.c).trimEnd(), '```', 'До:', '```json', JSON.stringify(r.doc1), '```', 'После:', '```json', JSON.stringify(r.doc2), '```', '')
  }
}
writeFileSync(here + 'results/details-editor.md', editorDetails.join('\n') + '\n')

console.log(readFileSync(here + 'results/summary.md', 'utf8'))
