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
  },
} satisfies Record<ArtifactKind, ArtifactKindSpec>)

/**
 * The kinds whose view has shipped: `artifact_create` and «Создать» accept only these (Ар7). Each
 * slice that ships a view adds its kind here — the document with 88.6 and 88.10, the mockup and
 * the table with Э5, the canvas and the brand with Э6. Empty until then.
 */
export const artifactReleasedKinds: readonly ArtifactKind[] = Object.freeze([])

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
