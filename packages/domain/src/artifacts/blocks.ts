import { z } from 'zod'

import { docSectionKeySchema, sectionMarkdownProblem } from '../pages/doc.ts'
import type { ArtifactBlockKind } from './kinds.ts'
import { artifactLimits, artifactRenderLimits } from './limits.ts'

/**
 * The blocks of an artifact (docs/plan/88-artifacts.md, Ар14, Ар15, §7.1, §7.2): what the content
 * of each kind of block is, and its properties. Properties come in two sorts (Ар15): values —
 * numbers, enumerations and flags — are decided by «the last one wins» (`props`); texts go through
 * the check of core like the content and change only under `ifRev` (`insert`, `replace`).
 */

/** The id of a block: the rule of `section_key` (plan 69), given by the agent or by the server. */
export const artifactBlockKeySchema = docSectionKeySchema

const oneLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (text) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text) && text.trim() === text,
      'one line of text',
    )

/** A title of an artifact, a heading, a name of a frame or a column: one line. */
export const artifactTitleSchema = oneLine(200)
export const artifactTextPropSchema = oneLine(200)
/** What the agent is about to write (`intent`, `lease_intent`): one line. */
export const artifactIntentSchema = oneLine(200)

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000)
const noteColors = ['yellow', 'green', 'blue', 'pink', 'grey'] as const

const none = z.strictObject({})
const size = z.number().finite().min(1).max(100_000)
const place = z.strictObject({
  x: coordinate.optional(),
  y: coordinate.optional(),
  w: size.optional(),
  h: size.optional(),
})

/** The value properties of each kind of block: «the last one wins» (Ар15). */
export const artifactBlockValuePropsSchemas = {
  section: none,
  frame: place,
  html: none,
  style: none,
  script: none,
  note: place.extend({ color: z.enum(noteColors).optional() }),
  settings: none,
  columns: none,
  row: none,
  diagram: none,
  node: place,
  chart: none,
} satisfies Record<ArtifactBlockKind, z.ZodObject>

/** The text properties of each kind of block: checked like the content, changed under `ifRev`. */
export const artifactBlockTextPropsSchemas = {
  section: z.strictObject({ heading: artifactTextPropSchema.optional() }),
  frame: z.strictObject({
    name: artifactTextPropSchema.optional(),
    variant: oneLine(40).optional(),
  }),
  html: none,
  style: none,
  script: none,
  note: none,
  settings: none,
  columns: none,
  row: none,
  diagram: none,
  node: z.strictObject({
    title: artifactTextPropSchema.optional(),
    goal: artifactTextPropSchema.optional(),
  }),
  chart: none,
} satisfies Record<ArtifactBlockKind, z.ZodObject>

/** Properties as an operation carries them before its block's kind is known. */
export const artifactPropsSchema = z
  .record(z.string().regex(/^[a-z][a-zA-Z]{0,23}$/), z.union([z.number(), z.string(), z.boolean()]))
  .refine((props) => Object.keys(props).length <= 16, 'at most 16 properties')
export type ArtifactProps = z.infer<typeof artifactPropsSchema>

export type ArtifactPropsMode = 'values' | 'texts' | 'all'

/**
 * Whether these properties fit a block of this kind: `values` — only value properties (the
 * operation `props`), `texts` — only text ones (`replace`), `all` — either (`insert`).
 */
export function artifactPropsProblem(
  kind: ArtifactBlockKind,
  props: ArtifactProps,
  mode: ArtifactPropsMode,
): string | null {
  const values = artifactBlockValuePropsSchemas[kind]
  const texts = artifactBlockTextPropsSchemas[kind]
  const schema = mode === 'values' ? values : mode === 'texts' ? texts : values.extend(texts.shape)
  const parsed = schema.safeParse(props)
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid properties')
}

/** The keys of text properties among these: the check of core reads them (Ар19). */
export function artifactTextPropKeys(kind: ArtifactBlockKind): readonly string[] {
  return Object.keys(artifactBlockTextPropsSchemas[kind].shape)
}

// ---- The table (§4, §7.7; the rules of pasting and CSV come with slice 88.14) ----

export const artifactColumnTypes = [
  'text',
  'number',
  'money',
  'date',
  'select',
  'link',
  'checkbox',
  'image',
] as const
export type ArtifactColumnType = (typeof artifactColumnTypes)[number]

export const artifactColumnSchema = z
  .strictObject({
    key: artifactBlockKeySchema,
    name: oneLine(80),
    type: z.enum(artifactColumnTypes),
    /** The choices of a `select` column. */
    options: z.array(oneLine(80)).min(1).max(50).optional(),
  })
  .refine((column) => (column.type === 'select') === (column.options !== undefined), {
    message: 'only a select column has options, and it has them',
  })
export type ArtifactColumn = z.infer<typeof artifactColumnSchema>

export const artifactColumnsSchema = z
  .array(artifactColumnSchema)
  .min(1)
  .max(50)
  .refine((columns) => new Set(columns.map((c) => c.key)).size === columns.length, {
    message: 'the keys of columns are unique',
  })

/** A cell: text, a number, a sum in roubles as a string (rule 9), a date, a flag, or empty. */
export const artifactCellSchema = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.boolean(),
  z.null(),
])
export type ArtifactCell = z.infer<typeof artifactCellSchema>

export const artifactCellsSchema = z
  .record(artifactBlockKeySchema, artifactCellSchema)
  .refine((cells) => Object.keys(cells).length <= 50, 'at most 50 cells')
export type ArtifactCells = z.infer<typeof artifactCellsSchema>

const moneyPattern = /^-?\d{1,10}(?:\.\d{1,2})?$/
const datePattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/
/** A real day of the calendar: «2026-02-31» is not one. */
const calendarDate = (value: string): boolean =>
  datePattern.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
const fileRefPattern =
  /^artifact-file:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Whether a value fits its column; null — it does (empty fits every column). */
export function artifactCellProblem(column: ArtifactColumn, value: ArtifactCell): string | null {
  if (value === null) return null
  switch (column.type) {
    case 'text':
      return typeof value === 'string' ? null : 'text expected'
    case 'number':
      return typeof value === 'number' ? null : 'a number expected'
    case 'money':
      return typeof value === 'string' && moneyPattern.test(value)
        ? null
        : 'a sum in roubles as a string with up to two decimals expected'
    case 'date':
      return typeof value === 'string' && calendarDate(value) ? null : 'a date YYYY-MM-DD expected'
    case 'select':
      return typeof value === 'string' && (column.options ?? []).includes(value)
        ? null
        : 'one of the options expected'
    case 'link':
      return typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value) && value.length <= 2000
        ? null
        : 'an https address expected'
    case 'checkbox':
      return typeof value === 'boolean' ? null : 'true or false expected'
    case 'image':
      return typeof value === 'string' && fileRefPattern.test(value)
        ? null
        : 'a reference artifact-file:<id> expected'
  }
}

// ---- The content of each kind of block ----

export type ArtifactContentProblem = 'too_large' | 'heading_level' | 'json' | 'shape' | 'not_empty'

const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const jsonObject = z.record(z.string(), z.unknown())

/**
 * Whether this content fits a block of this kind (§7.2): a section is Markdown with its own
 * headings from the third level; a frame holds nothing itself; `settings` and `chart` are a JSON
 * object, `columns` — the list of columns, `row` — its cells; a diagram is Mermaid text up to the
 * diagram's own bound; the rest is text. Every block is at most `blockBytes`, except a diagram.
 */
export function artifactBlockContentProblem(
  kind: ArtifactBlockKind,
  content: string,
): ArtifactContentProblem | null {
  if (kind === 'diagram')
    return content.length > artifactRenderLimits.diagramChars ? 'too_large' : null
  if (bytesOf(content) > artifactLimits.blockBytes) return 'too_large'
  switch (kind) {
    case 'section':
      return sectionMarkdownProblem(content)
    case 'frame':
      return content === '' ? null : 'not_empty'
    case 'note':
      return content.length > artifactLimits.commentChars ? 'too_large' : null
    case 'settings':
    case 'chart': {
      const value = jsonOf(content)
      if (value === undefined) return 'json'
      return jsonObject.safeParse(value).success ? null : 'shape'
    }
    case 'columns': {
      const value = jsonOf(content)
      if (value === undefined) return 'json'
      return artifactColumnsSchema.safeParse(value).success ? null : 'shape'
    }
    case 'row': {
      const value = jsonOf(content)
      if (value === undefined) return 'json'
      return artifactCellsSchema.safeParse(value).success ? null : 'shape'
    }
    default:
      return null
  }
}
