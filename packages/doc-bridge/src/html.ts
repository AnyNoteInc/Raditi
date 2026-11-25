import { parse, parseFragment } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'

// «Править текст» of a screen of a canvas on the server (docs/plan/88-artifacts.md, Ар9, §7.13; spike 1): the
// platform stamps an id into each element of a part of a frame as it serves the edit frame, and a
// person's edit of the text of one element comes back as a patch of the stored source by the
// offsets of parse5 — never as the live DOM of the frame. parse5 reads as a browser without
// scripts does (`scriptingEnabled: false`: `<noscript>` is markup). The copy of the edit frame
// differs from the source only by its links, which lead nowhere.

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
type TextNode = DefaultTreeAdapterMap['textNode']

/** The attribute of the ids the server stamps. */
export const ARTIFACT_ELEMENT_ID = 'data-rid'

/** Elements whose text is never edited: raw text, RCDATA and what is not rendered. */
const NOT_EDITABLE = new Set([
  'script',
  'style',
  'template',
  'textarea',
  'title',
  'noscript',
  'iframe',
  'xmp',
  'noembed',
  'noframes',
  'plaintext',
])

const options = { sourceCodeLocationInfo: true, scriptingEnabled: false } as const

const isElement = (node: Node): node is Element => 'tagName' in node
const isText = (node: Node): node is TextNode => node.nodeName === '#text'
const attrOf = (element: Element, name: string) =>
  element.attrs.find((attr) => attr.name === name)?.value

function walk(
  node: Node,
  visit: (node: Node, parents: readonly Element[]) => void,
  parents: Element[] = [],
) {
  visit(node, parents)
  const children = 'childNodes' in node ? node.childNodes : []
  const inner = isElement(node) ? [...parents, node] : parents
  for (const child of children) walk(child, visit, inner)
  if (isElement(node) && node.tagName === 'template' && 'content' in node)
    walk((node as DefaultTreeAdapterMap['template']).content, visit, inner)
}

interface Splice {
  at: number
  del: number
  text: string
}

const applied = (source: string, splices: readonly Splice[]) => {
  let out = source
  for (const splice of [...splices].sort((a, b) => b.at - a.at))
    out = out.slice(0, splice.at) + splice.text + out.slice(splice.at + splice.del)
  return out
}

const idOf = (block: string, n: number) => `${block}.${n}`

/** The splices that stamp `data-rid="<block>.<n>"` into every start tag the source really has. */
function stampSplices(block: string, html: string): Splice[] {
  const fragment = parseFragment(html, options)
  const splices: Splice[] = []
  let next = 1
  walk(fragment, (node) => {
    if (!isElement(node)) return
    const start = node.sourceCodeLocation?.startTag
    // Implied by the parser (tbody) or cloned by the adoption agency: no start tag of its own.
    if (!start) return
    const id = idOf(block, next++)
    const own = node.sourceCodeLocation?.attrs?.[ARTIFACT_ELEMENT_ID]
    if (own)
      splices.push({
        at: own.startOffset,
        del: own.endOffset - own.startOffset,
        text: `${ARTIFACT_ELEMENT_ID}="${id}"`,
      })
    else
      splices.push({
        at: start.startOffset + 1 + node.tagName.length,
        del: 0,
        text: ` ${ARTIFACT_ELEMENT_ID}="${id}"`,
      })
  })
  return splices
}

/** A part of a frame with an id in each element: what the edit frame shows of block `block`. */
export function stampArtifactHtml(block: string, html: string): string {
  return applied(html, stampSplices(block, html))
}

/** The offset in the source of an offset in its stamped copy (outside the stamped attributes). */
function sourceOffset(splices: readonly Splice[], stamped: number): number {
  let shift = 0
  for (const splice of [...splices].sort((a, b) => a.at - b.at)) {
    const at = splice.at + shift
    if (stamped < at + splice.text.length && stamped > at) throw new Error('inside a stamp')
    if (stamped >= at + splice.text.length) shift += splice.text.length - splice.del
    else break
  }
  return stamped - shift
}

/**
 * The copy the edit frame shows (Ар9; spike 1 and its check): links lead to a fragment that names
 * no element, without target, ping or download, in SVG (`xlink:href`) and MathML too; no `<base>`
 * and no `<meta http-equiv="refresh">`. Ids and slots of text do not move.
 */
export function artifactEditCopy(html: string): string {
  const fragment = parseFragment(html, options)
  const splices: Splice[] = []
  walk(fragment, (node) => {
    if (!isElement(node)) return
    const start = node.sourceCodeLocation?.startTag
    if (!start) return
    const attrs = node.sourceCodeLocation?.attrs ?? {}
    const drop = (name: string) => {
      const at = attrs[name]
      if (at) splices.push({ at: at.startOffset, del: at.endOffset - at.startOffset, text: '' })
    }
    const nowhere = (name: string) => {
      const at = attrs[name]
      if (at)
        splices.push({
          at: at.startOffset,
          del: at.endOffset - at.startOffset,
          text: 'href="#raditi-no-link"',
        })
    }
    const math = node.namespaceURI === 'http://www.w3.org/1998/Math/MathML'
    if (node.tagName === 'a' || node.tagName === 'area' || math) {
      nowhere('href')
      // An SVG link: the attribute keeps its prefix in the location table.
      drop('xlink:href')
      for (const name of ['target', 'ping', 'download']) drop(name)
    }
    if (node.tagName === 'base') for (const name of ['href', 'target']) drop(name)
    if (node.tagName === 'form') for (const name of ['action', 'target']) drop(name)
    if (node.tagName === 'meta' && (attrOf(node, 'http-equiv') ?? '').toLowerCase() === 'refresh') {
      const at = node.sourceCodeLocation!
      splices.push({ at: at.startOffset, del: at.endOffset - at.startOffset, text: '' })
    }
  })
  return applied(html, splices)
}

/** The non-text children of an element as the cabinet saw them: its shape. */
export function artifactElementShape(element: Element): string[] {
  return element.childNodes
    .filter((child) => !isText(child))
    .map((child) =>
      isElement(child)
        ? `${child.tagName}#${attrOf(child, ARTIFACT_ELEMENT_ID) ?? ''}`
        : child.nodeName,
    )
}

/** The slots of text of an element: the runs of text between its non-text children. */
function slotsOf(element: Element): { text: TextNode | null; after: Node | null }[] {
  const slots: { text: TextNode | null; after: Node | null }[] = [{ text: null, after: null }]
  for (const child of element.childNodes) {
    if (isText(child)) slots[slots.length - 1]!.text = child
    else slots.push({ text: null, after: child })
  }
  return slots
}

const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Whether the source between offsets reads as this text: no tag in it, the same decoded value. */
function decodesTo(html: string, start: number, end: number, value: string): boolean {
  const slice = html.slice(start, end)
  if (slice.includes('<')) return false
  const div = parseFragment(`<div>${slice}</div>`, { scriptingEnabled: false }).childNodes[0]
  if (!div || !isElement(div)) return false
  return div.childNodes.map((child) => (isText(child) ? child.value : '')).join('') === value
}

export type ArtifactTextPatchRefusal =
  | 'NO_ELEMENT'
  | 'AMBIGUOUS_ID'
  | 'NOT_EDITABLE'
  | 'SHAPE_CHANGED'
  | 'NO_SLOT'
  | 'TEXT_NOT_IN_PLACE'
  | 'CHECK_FAILED'

export type ArtifactTextPatch =
  { ok: true; html: string } | { ok: false; refusal: ArtifactTextPatchRefusal }

/** Elements of a stamped part by id; more than one — a clone of the adoption agency. */
function byId(stamped: string) {
  const found = new Map<string, { element: Element; parents: readonly Element[] }[]>()
  walk(parseFragment(stamped, options), (node, parents) => {
    if (!isElement(node)) return
    const id = attrOf(node, ARTIFACT_ELEMENT_ID)
    if (id === undefined) return
    found.set(id, [...(found.get(id) ?? []), { element: node, parents }])
  })
  return found
}

/**
 * A person's edit of the text of one element of block `block` (Ар9): its slots of text replaced by
 * plain text (markup is escaped). `shape` — the non-text children the cabinet saw. Refused when the
 * id names no element or two (a clone), the element is raw text, its shape changed, or its text is
 * not where the parser put it (foster parenting). The patch is made in the source, not the stamp.
 */
export function patchArtifactText(input: {
  block: string
  html: string
  id: string
  shape: readonly string[]
  edits: readonly { slot: number; text: string }[]
}): ArtifactTextPatch {
  const splices = stampSplices(input.block, input.html)
  const stamped = applied(input.html, splices)
  const found = byId(stamped).get(input.id) ?? []
  if (found.length !== 1)
    return { ok: false, refusal: found.length > 1 ? 'AMBIGUOUS_ID' : 'NO_ELEMENT' }
  const { element, parents } = found[0]!
  if (
    NOT_EDITABLE.has(element.tagName) ||
    parents.some((parent) => NOT_EDITABLE.has(parent.tagName))
  )
    return { ok: false, refusal: 'NOT_EDITABLE' }
  if (JSON.stringify(artifactElementShape(element)) !== JSON.stringify(input.shape))
    return { ok: false, refusal: 'SHAPE_CHANGED' }
  const slots = slotsOf(element)
  const patch: Splice[] = []
  try {
    for (const edit of input.edits) {
      const slot = slots[edit.slot]
      if (!slot) return { ok: false, refusal: 'NO_SLOT' }
      if (slot.text) {
        const at = slot.text.sourceCodeLocation
        if (!at || !decodesTo(stamped, at.startOffset, at.endOffset, slot.text.value))
          return { ok: false, refusal: 'TEXT_NOT_IN_PLACE' }
        const start = sourceOffset(splices, at.startOffset)
        const end = sourceOffset(splices, at.endOffset)
        patch.push({ at: start, del: end - start, text: escapeText(edit.text) })
      } else if (edit.text !== '') {
        const after =
          slot.after && isElement(slot.after)
            ? slot.after.sourceCodeLocation?.endOffset
            : slot.after?.sourceCodeLocation?.endOffset
        const at = after ?? element.sourceCodeLocation?.startTag?.endOffset
        if (at === undefined) return { ok: false, refusal: 'TEXT_NOT_IN_PLACE' }
        patch.push({ at: sourceOffset(splices, at), del: 0, text: escapeText(edit.text) })
      }
    }
  } catch {
    return { ok: false, refusal: 'TEXT_NOT_IN_PLACE' }
  }
  const html = applied(input.html, patch)
  // The check: stamped again, the element holds exactly the new texts and keeps its shape.
  const again = byId(stampArtifactHtml(input.block, html)).get(input.id) ?? []
  if (again.length !== 1) return { ok: false, refusal: 'CHECK_FAILED' }
  const after = slotsOf(again[0]!.element)
  for (const edit of input.edits)
    if ((after[edit.slot]?.text?.value ?? '') !== edit.text)
      return { ok: false, refusal: 'CHECK_FAILED' }
  if (JSON.stringify(artifactElementShape(again[0]!.element)) !== JSON.stringify(input.shape))
    return { ok: false, refusal: 'CHECK_FAILED' }
  return { ok: true, html }
}

/** The text inside an element as a reader sees it in order, without raw text (script, style…). */
function visibleText(element: Element): string {
  const pieces: string[] = []
  walk(element, (node, parents) => {
    if (!isText(node)) return
    if (parents.some((parent) => NOT_EDITABLE.has(parent.tagName))) return
    pieces.push(node.value)
  })
  return pieces.join(' ')
}

/**
 * The element of block `block` a note anchors to (Ар53, Ар27, slice 88.18е): its tag and the text
 * inside, read on the server from the checked source — never what a frame sent. Null — no element by
 * this id, two (a clone), or one inside raw text.
 */
export function artifactElementOf(input: {
  block: string
  html: string
  id: string
}): { tag: string; text: string } | null {
  if (!input.id.startsWith(`${input.block}.`)) return null
  const found = byId(stampArtifactHtml(input.block, input.html)).get(input.id) ?? []
  if (found.length !== 1) return null
  const { element, parents } = found[0]!
  if (NOT_EDITABLE.has(element.tagName) || parents.some((p) => NOT_EDITABLE.has(p.tagName)))
    return null
  return { tag: element.tagName, text: visibleText(element) }
}

// ---- Import of a whole HTML file (§7.2: a big one is cut by its top elements) ----

export interface ArtifactHtmlParts {
  style: string[]
  script: string[]
  html: string[]
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength

/**
 * A whole HTML document as the parts of a screen of a canvas: the inline styles and scripts of its head and
 * body, and its body cut by top elements into parts of at most `partBytes`. Scripts with `src` and
 * stylesheets by address are dropped: the frame loads nothing from the web. An element bigger than
 * a part on its own is refused by the caller's bound on the block.
 */
export function artifactHtmlParts(html: string, partBytes: number): ArtifactHtmlParts {
  const document = parse(html, options)
  const out: ArtifactHtmlParts = { style: [], script: [], html: [] }
  const inner = (element: Element) =>
    element.childNodes.map((child) => (isText(child) ? child.value : '')).join('')
  let part = ''
  const flush = () => {
    if (part.trim() !== '') out.html.push(part)
    part = ''
  }
  const take = (node: Node, inBody: boolean) => {
    if (isElement(node) && node.tagName === 'style') {
      out.style.push(inner(node))
      return
    }
    if (isElement(node) && node.tagName === 'script') {
      const type = (attrOf(node, 'type') ?? '').toLowerCase()
      if (
        attrOf(node, 'src') === undefined &&
        (type === '' || type === 'text/javascript' || type === 'module')
      )
        out.script.push(inner(node))
      return
    }
    if (!inBody) return
    const at = node.sourceCodeLocation
    if (!at) return
    const source = html.slice(at.startOffset, at.endOffset)
    if (part !== '' && bytes(part) + bytes(source) > partBytes) flush()
    part += source
  }
  const root = document.childNodes.find(
    (node): node is Element => isElement(node) && node.tagName === 'html',
  )
  for (const section of root?.childNodes ?? []) {
    if (!isElement(section)) continue
    for (const child of section.childNodes) take(child, section.tagName === 'body')
  }
  flush()
  return out
}

/** An SVG file as the one part of a screen of a canvas: centred on its page. */
export const artifactSvgPart = (svg: string): string =>
  `<main style="display:flex;justify-content:center;padding:24px">${svg.replace(/^\s*<\?xml[^>]*\?>/, '')}</main>`
