import { z } from 'zod'

/**
 * The registry of kinds of artifacts (docs/plan/88-artifacts.md, Ар6, Ар7, §4, §7.14; rule 8):
 * what a kind is made of, how it is shown, published and exported, and in which wave it comes.
 * The choice by kind lives here and nowhere else; a kind that left the list is read as history
 * through `artifactKindSpecOf()`, never created.
 */

export const artifactKinds = [
  'document',
  'mockup',
  'table',
  'canvas',
  'brand',
  'diagram',
  'slides',
  'image',
  'sitemap',
  'report',
] as const
export type ArtifactKind = (typeof artifactKinds)[number]
export const artifactKindSchema = z.enum(artifactKinds)

/**
 * What a block is (`chat_document_sections.block_kind`). A `section` is Markdown of a document;
 * a `frame` holds the `html`, `style` and `script` parts of one screen; `columns` and `row` are a
 * table; `settings` is the JSON a mockup's script reads; `note` is a sticky note of a canvas.
 */
export const artifactBlockKinds = [
  'section',
  'frame',
  'html',
  'style',
  'script',
  'note',
  'settings',
  'columns',
  'row',
  'diagram',
  'node',
  'chart',
] as const
export type ArtifactBlockKind = (typeof artifactBlockKinds)[number]
export const artifactBlockKindSchema = z.enum(artifactBlockKinds)

export const artifactViews = ['markdown', 'frame', 'canvas', 'sheet', 'brand', 'diagram'] as const
export type ArtifactView = (typeof artifactViews)[number]

export const artifactPublishKinds = ['reading-page', 'html', 'site'] as const
export type ArtifactPublishKind = (typeof artifactPublishKinds)[number]

export const artifactExportKinds = [
  'md',
  'pdf',
  'docx',
  'html',
  'png',
  'svg',
  'csv',
  'xlsx',
  'pptx',
  'css',
] as const
export type ArtifactExportKind = (typeof artifactExportKinds)[number]

export type ArtifactWave = 1 | 2 | 3

export interface ArtifactKindSpec {
  /** The name the client reads (rule 10). */
  label: string
  /** The kinds of blocks it is made of. */
  blocks: readonly ArtifactBlockKind[]
  view: ArtifactView
  /** «Опубликовать как страницу» (or «как сайт»); null — not published. */
  publish: ArtifactPublishKind | null
  exports: readonly ArtifactExportKind[]
  /** 1 — the first wave, 2 — the second, 3 — later (Ар6). */
  wave: ArtifactWave
  /** False — it never opens to others with «Правит»: it goes into every turn of a project (Ар25). */
  sharableEdit: boolean
  /** True — its `html` and `script` live inside frames (canvas, slides, image); false — at the top. */
  framed: boolean
  /**
   * What the agent makes of this kind, in English for the instructions of a pass (Ар4): the
   * result of the client's request that goes into an artifact of it.
   */
  forAgent: string
}

const frameParts = ['frame', 'html', 'style', 'script'] as const

export const artifactKindSpecs: Readonly<Record<ArtifactKind, ArtifactKindSpec>> = Object.freeze({
  document: {
    label: 'Документ',
    blocks: ['section'],
    view: 'markdown',
    publish: 'reading-page',
    exports: ['md', 'pdf', 'docx'],
    wave: 1,
    sharableEdit: true,
    framed: false,
    forAgent:
      'text to read, check or keep editing: an audit, a plan of work, a summary, an instruction, an article, a post, notes',
  },
  mockup: {
    label: 'Макет',
    blocks: ['html', 'style', 'script', 'settings'],
    view: 'frame',
    publish: 'html',
    exports: ['html', 'png', 'pdf'],
    wave: 1,
    sharableEdit: true,
    framed: false,
    forAgent:
      'a layout, a prototype of a page, a calculator. No skeleton: insert `html` blocks — fragments of the body, each up to 32 KiB —, `style` blocks of CSS, `script` blocks of JavaScript and one `settings` block: a JSON object of the numbers, prices and words the client may change, which the script reads by JSON.parse(document.getElementById("raditi-settings").textContent). The frame is sandboxed: no localStorage, sessionStorage, cookies, IndexedDB, service workers, pop-ups, navigation or network, no external font or script; the font Golos Text is there. A picture or a font goes in by `raditi_artifact_file_put`, its `artifact-file:<id>` where its address stands',
  },
  table: {
    label: 'Таблица',
    blocks: ['columns', 'row'],
    view: 'sheet',
    publish: 'reading-page',
    exports: ['csv', 'xlsx'],
    wave: 1,
    sharableEdit: true,
    framed: false,
    forAgent:
      'rows and columns: a price list, a content plan, a list to keep. No skeleton: insert one `columns` block — a JSON list of {key, name, type: text|number|money|date|select|link|checkbox, options of a select} — then a `row` block a row, the JSON of its cells by column key (money as a string "1990.50", a date "2026-11-12"); change cells by the operation `cells`',
  },
  canvas: {
    label: 'Холст',
    blocks: [...frameParts, 'note', 'settings'],
    view: 'canvas',
    publish: 'site',
    exports: ['html', 'png'],
    wave: 1,
    sharableEdit: true,
    framed: true,
    forAgent: 'the screens of a new site side by side, for a computer and a phone',
  },
  brand: {
    label: 'Фирменный стиль',
    blocks: ['settings', 'style', 'section'],
    view: 'brand',
    publish: null,
    exports: ['css'],
    wave: 1,
    sharableEdit: false,
    framed: false,
    forAgent: 'the colours, fonts and words of a brand',
  },
  diagram: {
    label: 'Схема',
    blocks: ['diagram'],
    view: 'diagram',
    publish: 'reading-page',
    exports: ['png', 'svg'],
    wave: 2,
    sharableEdit: true,
    framed: false,
    forAgent: 'a diagram: a process, a structure, a timeline',
  },
  slides: {
    label: 'Презентация',
    blocks: [...frameParts, 'note'],
    view: 'canvas',
    publish: 'html',
    exports: ['pdf', 'pptx'],
    wave: 2,
    sharableEdit: true,
    framed: true,
    forAgent: 'a presentation',
  },
  image: {
    label: 'Изображение',
    blocks: ['frame', 'html', 'style'],
    view: 'frame',
    publish: null,
    exports: ['png'],
    wave: 2,
    sharableEdit: true,
    framed: true,
    forAgent: 'a picture made of HTML: a banner, a card, a cover',
  },
  sitemap: {
    label: 'Структура сайта',
    blocks: ['node'],
    view: 'canvas',
    publish: 'site',
    exports: [],
    wave: 2,
    sharableEdit: true,
    framed: false,
    forAgent: 'the structure of a site: its pages and how they link',
  },
  report: {
    label: 'Отчёт',
    blocks: ['section', 'chart', 'columns', 'row'],
    view: 'markdown',
    publish: 'reading-page',
    exports: ['pdf'],
    wave: 2,
    sharableEdit: true,
    framed: false,
    forAgent: 'a report with charts and tables',
  },
} satisfies Record<ArtifactKind, ArtifactKindSpec>)

/**
 * The kinds whose view has shipped: `artifact_create` and «Создать» accept only these (Ар7). Each
 * slice that ships a view adds its kind here — the document with 88.6 and 88.10, the mockup and
 * the table with Э5, the canvas and the brand with Э6. The document shows in the tab «Документы»
 * of the chat until 88.10 gives it its own page.
 */
export const artifactReleasedKinds: readonly ArtifactKind[] = Object.freeze([
  'document',
  'mockup',
  'table',
])

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
