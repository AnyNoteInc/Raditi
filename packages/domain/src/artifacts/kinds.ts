import { z } from 'zod'

/**
 * The registry of kinds of artifacts (docs/plan/88-artifacts.md, Ар6, Ар7, §4, §7.14; rule 8):
 * what a kind is made of, how it is shown, published and exported. The choice by kind lives here
 * and nowhere else; a kind that left the list (docs/plan/93-artifacts-trim.md) is read as history
 * through `artifactKindSpecOf()`, never created.
 */

export const artifactKinds = ['document', 'canvas', 'slides', 'image'] as const
export type ArtifactKind = (typeof artifactKinds)[number]
export const artifactKindSchema = z.enum(artifactKinds)

/**
 * What a block is (`chat_document_sections.block_kind`). A `section` is Markdown of a document;
 * a `frame` holds the `html`, `style` and `script` parts of one screen, slide or picture;
 * `settings` is the JSON the scripts of a canvas read; `note` is a sticky note of a canvas or the
 * speaker notes of a slide.
 */
export const artifactBlockKinds = [
  'section',
  'frame',
  'html',
  'style',
  'script',
  'note',
  'settings',
] as const
export type ArtifactBlockKind = (typeof artifactBlockKinds)[number]
export const artifactBlockKindSchema = z.enum(artifactBlockKinds)

export const artifactViews = ['markdown', 'canvas'] as const
export type ArtifactView = (typeof artifactViews)[number]

export const artifactPublishKinds = ['reading-page', 'site'] as const
export type ArtifactPublishKind = (typeof artifactPublishKinds)[number]

export const artifactExportKinds = ['md', 'pdf', 'png', 'pptx'] as const
export type ArtifactExportKind = (typeof artifactExportKinds)[number]

export interface ArtifactKindSpec {
  /** The name the client reads (rule 10). */
  label: string
  /** The kinds of blocks it is made of. */
  blocks: readonly ArtifactBlockKind[]
  view: ArtifactView
  /** «Опубликовать как страницу» (or «как сайт»); null — not published. */
  publish: ArtifactPublishKind | null
  exports: readonly ArtifactExportKind[]
  /** What private notes anchor to (Ар53): a quote of a section (88.18а), an element of a frame (88.18е). */
  notes?: 'quote' | 'element'
  /** True — its `html` and `script` live inside frames (canvas, slides, image); false — a document. */
  framed: boolean
  /**
   * What an artifact of this kind is for, in English for the instructions of a pass: the agent
   * makes one only when the client asks for it or the result does not fit the chat
   * (docs/plan/100-artifacts-on-demand.md, АЗ1, АЗ3).
   */
  forAgent: string
}

const frameParts = ['frame', 'html', 'style', 'script'] as const

/**
 * The rules of every frame (canvas, slides, image; docs/plan/93-artifacts-trim.md, АТ6): what the
 * sandbox of a frame allows, the font and the files.
 */
export const artifactFrameRules =
  'Each html block is a fragment of the body, up to 32 KiB, no skeleton. The frame is sandboxed: no localStorage, sessionStorage, cookies, IndexedDB, service workers, pop-ups, navigation or network, no external font or script; the font Golos Text is there. A picture or a font goes in by `raditi_artifact_file_put`, its `artifact-file:<id>` where its address stands'

export const artifactKindSpecs: Readonly<Record<ArtifactKind, ArtifactKindSpec>> = Object.freeze({
  document: {
    label: 'Документ',
    blocks: ['section'],
    view: 'markdown',
    publish: 'reading-page',
    // «Скачать → Markdown» of the cabinet, made in the browser; no PDF or Word yet (92, АТ9).
    exports: ['md'],
    notes: 'quote',
    framed: false,
    forAgent:
      'a long text to keep, edit or pass on: an article, an instruction, a report, an audit, a plan of work; rows of data are a Markdown table inside a section',
  },
  canvas: {
    label: 'Холст',
    blocks: [...frameParts, 'note', 'settings'],
    view: 'canvas',
    publish: 'site',
    // No download (АТ6): the renderer draws a picture only of a fixed frame, so a PNG of an
    // adaptive screen always failed; a PDF would print a calculator without its script.
    exports: [],
    notes: 'element',
    framed: true,
    forAgent: `a page, a layout or a prototype, a landing, a calculator or a form with prices, or the screens of a site. One screen is one \`frame\` block — props \`name\` (the screen: «Главная», «Услуги»), \`path\` of its page when published ("/", "/uslugi"), \`variant\` («А», «Б») for variants of one screen; a prototype or a calculator is one frame with \`path\` "/", a site is one frame a page side by side. A screen is one adaptive page drawn for a computer (1440) and a phone (390): its \`html\`, \`style\` and \`script\` blocks stand inside it (\`parent\`: the frame); a \`style\` block at the top is the common style of every screen — keep the colours and fonts there as CSS variables on :root. Put the numbers, prices, words and switches the client may change into one \`settings\` block at the top: a flat JSON object of strings, numbers, booleans and colours #rrggbb, which a script reads by JSON.parse(document.getElementById("raditi-settings").textContent); the client edits them in «Настройки» without you. A \`note\` at the top is a sticky note, a \`note\` inside a frame a pin (props x, y in per cent). ${artifactFrameRules}. After drawing a screen check it with \`raditi_artifact_layout\``,
  },
  slides: {
    label: 'Презентация',
    blocks: [...frameParts, 'note'],
    view: 'canvas',
    // A small site of its slides, one page each, the first at the root (88.25в).
    publish: 'site',
    exports: ['pdf', 'pptx'],
    framed: true,
    forAgent:
      'a presentation for a talk, a pitch or a meeting: slides of 1280×720 on the deck theme, one idea a slide',
  },
  image: {
    label: 'Изображение',
    blocks: ['frame', 'html', 'style'],
    // Frames of their own sizes, with thumbnails and `/v/` as the canvas has (88.26).
    view: 'canvas',
    publish: null,
    exports: ['png'],
    framed: true,
    forAgent: 'a picture made of HTML: a banner, a card, a cover',
  },
} satisfies Record<ArtifactKind, ArtifactKindSpec>)

/**
 * The kinds whose view has shipped: `artifact_create` and «Создать» accept only these (Ар7). All
 * four kinds that stayed after plan 93 have shipped.
 */
export const artifactReleasedKinds: readonly ArtifactKind[] = Object.freeze([...artifactKinds])

export function artifactKindKnown(value: string): value is ArtifactKind {
  return (artifactKinds as readonly string[]).includes(value)
}

/** The spec of a kind read back from a row; null — a kind that left the list (history). */
export function artifactKindSpecOf(value: string): ArtifactKindSpec | null {
  return artifactKindKnown(value) ? artifactKindSpecs[value] : null
}

/** Whether a new artifact of this kind may be created now (Ар7). */
export function artifactKindCreatable(
  kind: string,
  released: readonly ArtifactKind[] = artifactReleasedKinds,
): kind is ArtifactKind {
  return artifactKindKnown(kind) && released.includes(kind)
}

export type ArtifactPlacementProblem = 'kind' | 'parent'

/**
 * Whether a block of this kind may stand at this place of an artifact (§7.2): its kind must be one
 * of the artifact's. In a framed kind (`framed`: canvas, slides, image) `html` and `script` stand
 * inside a frame, `style` and `note` inside a frame or at the top (the common style of a canvas, the
 * speaker notes of a slide); everything else, and every block of the other kinds, stands at the top.
 */
export function artifactBlockPlacementProblem(
  artifact: ArtifactKind,
  block: ArtifactBlockKind,
  parent: ArtifactBlockKind | null,
): ArtifactPlacementProblem | null {
  if (!artifactKindSpecs[artifact].blocks.includes(block)) return 'kind'
  if (artifactKindSpecs[artifact].framed) {
    if (block === 'html' || block === 'script') return parent === 'frame' ? null : 'parent'
    if (block === 'style') return parent === null || parent === 'frame' ? null : 'parent'
    // Speaker notes stand on their slide; a canvas's sticky notes may stand on a frame too.
    if (block === 'note') return parent === null || parent === 'frame' ? null : 'parent'
  }
  return parent === null ? null : 'parent'
}
