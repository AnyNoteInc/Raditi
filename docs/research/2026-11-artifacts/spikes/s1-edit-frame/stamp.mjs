// Server side of «Править текст» (plan 88, Ар9): stamp element ids into the source and patch the
// source by parse5 offsets. The live DOM of the frame is never serialized back.
import { parse, serialize } from 'parse5'

export const ID_ATTR = 'data-rid'
const ID_RE = /^e\d+$/

/** Elements whose text the cabinet never edits: raw text, RCDATA, and what is not rendered. */
const NOT_EDITABLE = new Set(['script', 'style', 'template', 'textarea', 'title', 'noscript', 'iframe', 'xmp', 'noembed', 'noframes', 'plaintext'])

function walk(node, fn, parents = []) {
  fn(node, parents)
  const kids = node.childNodes ?? []
  for (const c of kids) walk(c, fn, [...parents, node])
  if (node.content) walk(node.content, fn, [...parents, node])
}

const attrOf = (el, name) => el.attrs?.find((a) => a.name === name)?.value

/**
 * Puts `data-rid="eN"` into every start tag of the body that the source really has. Ids the
 * source already holds stay when they are well formed and unique; the rest are renumbered.
 * `scriptingEnabled: false` — parse as a browser does in a frame without scripts (noscript is markup).
 */
export function stamp(html, { scriptingEnabled = false } = {}) {
  const doc = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled })
  const edits = [] // {at, del, text}
  const seen = new Set()
  let next = 1
  const taken = new Set()
  walk(doc, (n) => {
    const v = n.tagName ? attrOf(n, ID_ATTR) : undefined
    if (v && ID_RE.test(v)) taken.add(v)
  })
  const fresh = () => {
    while (taken.has(`e${next}`) || seen.has(`e${next}`)) next++
    const id = `e${next++}`
    seen.add(id)
    return id
  }
  walk(doc, (n, parents) => {
    if (!n.tagName) return
    if (!parents.some((p) => p.tagName === 'body') && n.tagName !== 'body') return
    const loc = n.sourceCodeLocation?.startTag
    if (!loc) return // implied by the parser (tbody) or cloned by the adoption agency
    const current = attrOf(n, ID_ATTR)
    const attrLoc = n.sourceCodeLocation.startTag.attrs?.[ID_ATTR]
    if (current && ID_RE.test(current) && !seen.has(current)) {
      seen.add(current)
      return
    }
    const id = fresh()
    if (attrLoc) edits.push({ at: attrLoc.startOffset, del: attrLoc.endOffset - attrLoc.startOffset, text: `${ID_ATTR}="${id}"` })
    else edits.push({ at: loc.startOffset + 1 + n.tagName.length, del: 0, text: ` ${ID_ATTR}="${id}"` })
  })
  edits.sort((a, b) => b.at - a.at)
  let out = html
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.del)
  return { html: out, stamped: edits.length }
}

/** The elements of a document by id, with their parents. */
function index(html, scriptingEnabled) {
  const doc = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled })
  const byId = new Map()
  walk(doc, (n, parents) => {
    if (!n.tagName) return
    const id = attrOf(n, ID_ATTR)
    if (!id) return
    const list = byId.get(id) ?? []
    list.push({ node: n, parents })
    byId.set(id, list)
  })
  return { doc, byId }
}

/** Text slots of an element: the runs of text between its non-text children (0..n). */
export function slotsOf(el) {
  const slots = [{ text: null, node: null }]
  for (const c of el.childNodes) {
    if (c.nodeName === '#text') {
      slots[slots.length - 1] = { text: c.value, node: c }
    } else {
      slots.push({ text: null, node: null, after: c })
    }
  }
  return slots
}

export const shapeOf = (el) =>
  el.childNodes.filter((c) => c.nodeName !== '#text').map((c) => (c.tagName ? `${c.tagName}#${attrOf(c, ID_ATTR) ?? ''}` : c.nodeName))

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function sliceDecodes(html, start, end, value) {
  const slice = html.slice(start, end)
  if (slice.includes('<')) return false
  const frag = parse(`<!doctype html><body><div>${slice}</div>`, { scriptingEnabled: false })
  const body = frag.childNodes.find((n) => n.tagName === 'html').childNodes.find((n) => n.tagName === 'body')
  const div = body.childNodes[0]
  const got = div.childNodes.map((c) => c.value ?? '').join('')
  return got === value
}

/**
 * Replaces text slots of one stamped element. `edits` — [{slot, text}] in plain text: markup is
 * escaped. `shape` — the non-text children the cabinet saw, the patch refuses when it changed.
 * Returns { ok, html, refusal, ranges }.
 */
export function patchText(html, { id, shape, edits, scriptingEnabled = false }) {
  const { byId } = index(html, scriptingEnabled)
  const found = byId.get(id) ?? []
  if (found.length !== 1) return { ok: false, refusal: found.length ? 'AMBIGUOUS_ID' : 'NO_ELEMENT' }
  const { node: el, parents } = found[0]
  if (NOT_EDITABLE.has(el.tagName) || parents.some((p) => NOT_EDITABLE.has(p.tagName))) return { ok: false, refusal: 'NOT_EDITABLE' }
  if (!el.sourceCodeLocation?.startTag) return { ok: false, refusal: 'NO_SOURCE' }
  if (JSON.stringify(shapeOf(el)) !== JSON.stringify(shape)) return { ok: false, refusal: 'SHAPE_CHANGED' }
  const slots = slotsOf(el)
  const ops = []
  for (const { slot, text } of edits) {
    const s = slots[slot]
    if (!s) return { ok: false, refusal: 'NO_SLOT' }
    if (s.node) {
      const { startOffset, endOffset } = s.node.sourceCodeLocation ?? {}
      if (startOffset === undefined) return { ok: false, refusal: 'NO_SOURCE' }
      if (!sliceDecodes(html, startOffset, endOffset, s.node.value)) return { ok: false, refusal: 'TEXT_NOT_IN_PLACE' }
      ops.push({ at: startOffset, del: endOffset - startOffset, text: escapeText(text) })
    } else {
      // No text in this slot yet: insert after the previous child, or after the start tag.
      const prev = s.after
      let at
      if (prev) at = prev.sourceCodeLocation?.endOffset
      else at = el.sourceCodeLocation.startTag.endOffset
      if (at === undefined) return { ok: false, refusal: 'NO_SOURCE' }
      if (text !== '') ops.push({ at, del: 0, text: escapeText(text) })
    }
  }
  ops.sort((a, b) => b.at - a.at)
  let out = html
  for (const o of ops) out = out.slice(0, o.at) + o.text + out.slice(o.at + o.del)
  // Check: parse again, the element holds exactly the new texts and keeps its shape.
  const again = index(out, scriptingEnabled).byId.get(id) ?? []
  if (again.length !== 1) return { ok: false, refusal: 'CHECK_FAILED' }
  const newSlots = slotsOf(again[0].node)
  for (const { slot, text } of edits) if ((newSlots[slot]?.text ?? '') !== text) return { ok: false, refusal: 'CHECK_FAILED' }
  if (JSON.stringify(shapeOf(again[0].node)) !== JSON.stringify(shape)) return { ok: false, refusal: 'CHECK_FAILED' }
  return { ok: true, html: out, ranges: ops.map((o) => [o.at, o.del]) }
}

/** Ids that occur more than once in the parsed tree (clones of the adoption agency). */
export function duplicateIds(html, { scriptingEnabled = false } = {}) {
  const { byId } = index(html, scriptingEnabled)
  return [...byId].filter(([, l]) => l.length > 1).map(([id]) => id)
}

/** Text nodes of the body whose source slice does not decode to their value (fostered, merged). */
export function misplacedTexts(html, { scriptingEnabled = false } = {}) {
  const doc = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled })
  const bad = []
  walk(doc, (n, parents) => {
    if (n.nodeName !== '#text' || !n.value.trim()) return
    if (parents.some((p) => NOT_EDITABLE.has(p.tagName))) return
    if (!parents.some((p) => p.tagName === 'body')) return
    const l = n.sourceCodeLocation
    if (!l || !sliceDecodes(html, l.startOffset, l.endOffset, n.value)) bad.push(n.value.trim().slice(0, 30))
  })
  return bad
}

/** The canonical form: parse5 serialization (fixes misnesting, so offsets tell the truth). */
export const canonical = (html, { scriptingEnabled = false } = {}) => serialize(parse(html, { scriptingEnabled }))

/**
 * The copy the edit frame shows: links lead nowhere (a fragment that names no element), no
 * target, ping or download, no <base>, no <meta http-equiv="refresh">. The stored source keeps
 * them; text slots and ids do not move, so a patch made through this copy fits the source.
 */
export function editCopy(html, { scriptingEnabled = false } = {}) {
  const doc = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled })
  const edits = []
  walk(doc, (n) => {
    if (!n.tagName || !n.sourceCodeLocation?.startTag) return
    const attrs = n.sourceCodeLocation.startTag.attrs ?? {}
    const drop = (name) => attrs[name] && edits.push({ at: attrs[name].startOffset, del: attrs[name].endOffset - attrs[name].startOffset, text: '' })
    if (n.tagName === 'a' || n.tagName === 'area') {
      if (attrs.href) edits.push({ at: attrs.href.startOffset, del: attrs.href.endOffset - attrs.href.startOffset, text: 'href="#raditi-no-link"' })
      for (const a of ['target', 'ping', 'download']) drop(a)
    }
    if (n.tagName === 'base') for (const a of ['href', 'target']) drop(a)
    if (n.tagName === 'meta' && (attrOf(n, 'http-equiv') ?? '').toLowerCase() === 'refresh') {
      const l = n.sourceCodeLocation
      edits.push({ at: l.startOffset, del: l.endOffset - l.startOffset, text: '' })
    }
  })
  edits.sort((a, b) => b.at - a.at)
  let out = html
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.del)
  return out
}
