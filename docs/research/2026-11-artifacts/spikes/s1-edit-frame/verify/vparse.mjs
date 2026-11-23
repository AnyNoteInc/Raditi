// Independent server-side check of spike 1: parse5 facts the plan leans on, and inputs the builder's
// stamp.mjs (../stamp.mjs, the system under test) was not given.
// node vparse.mjs
import { parse } from 'parse5'
import { stamp, patchText, editCopy, duplicateIds, misplacedTexts } from '../stamp.mjs'

const out = {}
const find = (node, pred, acc = []) => {
  if (pred(node)) acc.push(node)
  for (const c of node.childNodes ?? []) find(c, pred, acc)
  if (node.content) find(node.content, pred, acc)
  return acc
}
const attrOf = (el, n) => el.attrs?.find((a) => a.name === n)?.value

// 1. <noscript>: markup only when parsed as a browser without scripts parses it.
{
  const html = '<!doctype html><body><noscript><p id="ns">Без скриптов</p></noscript></body>'
  const t = find(parse(html), (n) => n.tagName === 'p').length
  const f = find(parse(html, { scriptingEnabled: false }), (n) => n.tagName === 'p').length
  out.noscript = { scriptingEnabledDefault: t, scriptingEnabledFalse: f }
}
// 2. Adoption agency: the clone carries the attributes of the original, data-rid included.
{
  const s = stamp('<!doctype html><body><b>жирный<p>абзац</b>хвост</p></body>')
  out.adoption = { stamped: s.stamped, duplicates: duplicateIds(s.html), bs: find(parse(s.html, { scriptingEnabled: false }), (n) => n.tagName === 'b').map((b) => attrOf(b, 'data-rid')) }
  const id = out.adoption.duplicates[0]
  out.adoption.patchOriginal = patchText(s.html, { id, shape: [], edits: [{ slot: 0, text: 'x' }] }).refusal
}
// 3. Foster parenting: the text moved out of the table keeps source offsets inside the table.
{
  const html = '<!doctype html><body><table><tr><td>ячейка</td></tr>фостер</table></body>'
  out.foster = { misplaced: misplacedTexts(html) }
  const s = stamp('<!doctype html><body><div><table><tr><td>я</td></tr>фостер</table></div></body>')
  const div = find(parse(s.html, { scriptingEnabled: false, sourceCodeLocationInfo: true }), (n) => n.tagName === 'div')[0]
  const rid = attrOf(div, 'data-rid')
  const shape = div.childNodes.filter((c) => c.nodeName !== '#text').map((c) => `${c.tagName}#${attrOf(c, 'data-rid') ?? ''}`)
  out.foster.patch = patchText(s.html, { id: rid, shape, edits: [{ slot: 0, text: 'новый' }] }).refusal
}
// 4. Inputs of the agent's HTML the spike did not try.
const cases = {
  'pre with a leading newline': ['<pre>\nстрока</pre>', 'pre', 0, 'новая'],
  'CRLF inside text': ['<p>раз\r\nдва</p>', 'p', 0, 'три'],
  'ampersand without semicolon': ['<p>A&amp B &copy C</p>', 'p', 0, 'D'],
  'list items with implied ends': ['<ul><li>первый<li>второй</ul>', 'li', 0, 'новый'],
  'UPPERCASE tags': ['<P ID="x">Текст</P>', 'p', 0, 'Новый'],
  'svg text': ['<svg><text x="0" y="10">подпись</text></svg>', 'text', 0, 'новая'],
  'markup in the new text': ['<p>старый</p>', 'p', 0, '</p><script>x()</script>'],
  'nbsp entity in the slot': ['<p>с&nbsp;шести</p>', 'p', 0, 'с семи'],
  'empty slot after an element with an implied end': ['<div><p>абзац</div>', 'div', 1, 'хвост'],
}
out.patches = {}
for (const [label, [body, tag, slot, text]] of Object.entries(cases)) {
  const html = `<!doctype html><html><head></head><body>${body}</body></html>`
  const s = stamp(html)
  const el = find(parse(s.html, { scriptingEnabled: false, sourceCodeLocationInfo: true }), (n) => n.tagName === tag)[0]
  const rid = attrOf(el, 'data-rid')
  const shape = el.childNodes.filter((c) => c.nodeName !== '#text').map((c) => (c.tagName ? `${c.tagName}#${attrOf(c, 'data-rid') ?? ''}` : c.nodeName))
  const r = patchText(s.html, { id: rid, shape, edits: [{ slot, text }] })
  let check = null
  if (r.ok) {
    const again = find(parse(r.html, { scriptingEnabled: false }), (n) => attrOf(n, 'data-rid') === rid)[0]
    const slots = [null]
    for (const c of again.childNodes) if (c.nodeName === '#text') slots[slots.length - 1] = (slots.at(-1) ?? '') + c.value
    else slots.push(null)
    const [at, del] = r.ranges[0]
    check = { slotNow: slots[slot], before: s.html.slice(0, at) === r.html.slice(0, at), after: s.html.slice(at + del) === r.html.slice(r.html.length - (s.html.length - at - del)), scripts: find(parse(r.html), (n) => n.tagName === 'script').length }
  }
  out.patches[label] = { ok: r.ok, refusal: r.refusal ?? null, check }
}
// 5. Duplicate data-rid planted in the source by the author of the artifact.
{
  const s = stamp('<!doctype html><body><p data-rid="e1">a</p><p data-rid="e1">b</p><p data-rid="e9" data-rid="e1">c</p></body>')
  out.plantedIds = { html: s.html.replace(/^.*<body>/, '').replace(/<\/body>.*$/, ''), duplicates: duplicateIds(s.html) }
}
// 6. The edit copy: which link-like attributes stay.
{
  const html = '<!doctype html><body><a href="/a">a</a><svg><a href="/s">s</a><a xlink:href="/x">x</a></svg><math><mtext href="/m">m</mtext></math><area href="/r"><form action="/f"><button formaction="/b">b</button></form></body>'
  const c = editCopy(html)
  out.editCopy = { left: ['/a', '/s', '/x', '/m', '/r', '/f', '/b'].filter((u) => c.includes(`"${u}"`)) }
}
console.log(JSON.stringify(out, null, 1))
