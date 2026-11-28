import type { QuickEditBlock } from '@repo/db'
import {
  artifactElementSource,
  artifactHtmlEditRisk,
  replaceArtifactElements,
} from '@repo/doc-bridge'
import { artifactSectionText } from '@repo/doc-render/markdown'
import {
  applyQuickEdits,
  hasUniqueCommentQuote,
  artifactLimits,
  commentCellText,
  normalizeCommentQuote,
  paragraphOfQuote,
  quickEditLimits,
  splitParagraphs,
  type ArtifactCommentSnapshot,
  type QuickEditEdit,
  type QuickEditNote,
  type QuickEditPart,
  type QuickEditReason,
} from '@repo/domain/artifacts'

// What the model sees of the notes of a quick edit and how its answer goes back into blocks
// (docs/plan/98-quick-edits.md): a «Документ» gives the Markdown of the sections of its quotes,
// a «Холст» the HTML source of the elements its notes anchor to (stage 4).

export type QuickEditApplied =
  | { ok: true; blocks: Map<string, string> }
  /** `problem` — worth the one retry; `reason` — the edit ends with it. */
  | { ok: false; problem: string; reason?: QuickEditReason }

export interface QuickEditPrepared {
  parts: QuickEditPart[]
  notes: QuickEditNote[]
  /** The answer's edits as the new source of each changed block. */
  apply(edits: readonly QuickEditEdit[]): QuickEditApplied
}

type Note = ArtifactCommentSnapshot[number]

const repliesOf = (note: Note): QuickEditNote['replies'] =>
  note.replies.map((reply) =>
    typeof reply === 'string'
      ? { by: 'client' as const, body: reply }
      : { by: 'other' as const, body: reply.body },
  )

/** A «Документ»: each part is a section; a quote no longer once in it — the place moved. */
export function documentParts(
  notes: readonly Note[],
  byKey: ReadonlyMap<string, QuickEditBlock>,
): QuickEditPrepared | QuickEditReason {
  const parts: QuickEditPart[] = [...byKey.values()].map((block) => ({
    key: block.key,
    heading: block.heading,
    markdown: block.markdown,
  }))
  if (
    parts.reduce((sum, part) => sum + Buffer.byteLength(part.markdown), 0) >
    quickEditLimits.sourceBytes
  )
    return 'limit'
  const promptNotes: QuickEditNote[] = []
  for (const note of notes) {
    const anchor = note.anchor as { kind: string; block: string; quote?: string }
    const block = byKey.get(anchor.block)
    if (anchor.kind !== 'quote' || !block) return 'moved'
    const quote = normalizeCommentQuote(anchor.quote ?? '')
    if (!hasUniqueCommentQuote(normalizeCommentQuote(artifactSectionText(block.markdown)), quote))
      return 'moved'
    promptNotes.push({
      id: note.id,
      // Every note is the clicker's request: notes of others only after their confirmation (БПр9).
      by: 'client',
      part: anchor.block,
      p: paragraphOfQuote(splitParagraphs(block.markdown).paragraphs, quote, artifactSectionText),
      quote,
      body: note.body,
      replies: repliesOf(note),
    })
  }
  return {
    parts,
    notes: promptNotes,
    apply: (edits) => {
      const applied = applyQuickEdits(parts, edits)
      return applied.ok ? applied : { ok: false, problem: applied.problem }
    },
  }
}

interface CanvasElement {
  alias: string
  block: string
  id: string
  tag: string
  source: string
  start: number
  end: number
}

/**
 * A «Холст»: each part is one element a note anchors to, under a short alias (an id has a dot,
 * a key of a part may not). An element inside another chosen one is read as that one: the outer
 * source holds it. The element must be where the note saw it: the same tag (Ар27).
 */
export function canvasParts(
  notes: readonly Note[],
  byKey: ReadonlyMap<string, QuickEditBlock>,
): QuickEditPrepared | QuickEditReason {
  const found: (CanvasElement & { noteId: string; text: string })[] = []
  for (const note of notes) {
    const anchor = note.anchor as {
      kind: string
      block: string
      element?: string
      tag?: string
      text?: string
    }
    const block = byKey.get(anchor.block)
    if (anchor.kind !== 'element' || !block || anchor.element === undefined) return 'moved'
    const source = artifactElementSource({
      block: block.key,
      html: block.markdown,
      id: anchor.element,
    })
    if (source === null || (anchor.tag !== undefined && source.tag !== anchor.tag)) return 'moved'
    // An id names an element by its order: another element of the same tag may hold it now. The
    // text the client saw is the proof it is still theirs (Ар27).
    if (anchor.text !== undefined && commentCellText(source.text) !== anchor.text) return 'moved'
    found.push({
      ...source,
      text: anchor.text ?? commentCellText(source.text),
      alias: '',
      block: block.key,
      noteId: note.id,
    })
  }
  // Two notes on one element share its part; an element inside another is read as the outer one.
  const inside = (inner: CanvasElement, outer: CanvasElement) =>
    inner.id !== outer.id &&
    inner.block === outer.block &&
    inner.start >= outer.start &&
    inner.end <= outer.end
  const elements: CanvasElement[] = []
  for (const each of found)
    if (!found.some((other) => inside(each, other)) && !elements.some((e) => e.id === each.id))
      elements.push({ ...each, alias: `e${elements.length + 1}` })
  const holder = (each: CanvasElement) =>
    elements.find((element) => element.id === each.id || inside(each, element))!
  if (
    elements.reduce((sum, element) => sum + Buffer.byteLength(element.source), 0) >
    quickEditLimits.sourceBytes
  )
    return 'limit'
  const parts: QuickEditPart[] = elements.map((element) => ({
    key: element.alias,
    heading: null,
    markdown: element.source,
    tag: element.tag,
  }))
  const promptNotes: QuickEditNote[] = notes.map((note, index) => {
    const element = holder(found[index]!)
    return {
      id: note.id,
      by: 'client',
      part: element.alias,
      p: splitParagraphs(element.source).paragraphs.length === 1 ? 1 : null,
      quote: found[index]!.text,
      body: note.body,
      replies: repliesOf(note),
    }
  })
  // The client's own words may bring an address (БПр8): the notes and their replies.
  const allowed = notes
    .flatMap((note) => [note.body, ...note.replies.filter((reply) => typeof reply === 'string')])
    .join('\n')
  return {
    parts,
    notes: promptNotes,
    apply: (edits) => {
      const applied = applyQuickEdits(parts, edits)
      if (!applied.ok) return { ok: false, problem: applied.problem }
      const perBlock = new Map<string, { id: string; source: string; to: string }[]>()
      for (const [alias, to] of applied.blocks) {
        const element = elements.find((each) => each.alias === alias)!
        // Read as a browser reads it: what runs or loads is refused, an address the client did not
        // give is refused (БПр8); neither is asked again.
        const risk = artifactHtmlEditRisk({ before: element.source, after: to, allowed })
        if (risk !== null)
          return {
            ok: false,
            problem: `part ${alias} brings ${risk.detail}`,
            reason: risk.kind === 'active' ? 'check' : 'links',
          }
        perBlock.set(element.block, [
          ...(perBlock.get(element.block) ?? []),
          { id: element.id, source: element.source, to },
        ])
      }
      const blocks = new Map<string, string>()
      for (const [key, replacements] of perBlock) {
        const block = byKey.get(key)!
        const result = replaceArtifactElements({ block: key, html: block.markdown, replacements })
        if (!result.ok) {
          if (result.refusal === 'NOT_ONE_ELEMENT' || result.refusal === 'SPILLS')
            return {
              ok: false,
              problem:
                'each part must stay exactly one element of the same tag, closing every tag it opens',
            }
          return {
            ok: false,
            problem: result.refusal,
            reason: result.refusal === 'CHANGED' ? 'stale' : 'moved',
          }
        }
        if (Buffer.byteLength(result.html) > artifactLimits.blockBytes)
          return { ok: false, problem: 'the block grows too large', reason: 'limit' }
        if (result.html !== block.markdown) blocks.set(key, result.html)
      }
      return { ok: true, blocks }
    },
  }
}
