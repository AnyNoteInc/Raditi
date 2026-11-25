import { z } from 'zod'

import { docSectionKeySchema, sectionMarkdownProblem } from '../pages/doc.ts'
import type { ArtifactBlockKind } from './kinds.ts'
import { artifactLimits } from './limits.ts'

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

/** A title of an artifact, a heading, a name of a frame: one line. */
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
  // `chosen` — the variant of a screen the client chose: «Опубликовать как сайт» takes it (Ар8);
  // `size` — the size of a picture of «Изображение», by the name of its place (88.26).
  frame: place.extend({
    chosen: z.boolean().optional(),
    size: z.enum(['post', 'portrait', 'story', 'vk-cover', 'banner', 'wide']).optional(),
  }),
  html: none,
  style: none,
  script: none,
  note: place.extend({ color: z.enum(noteColors).optional() }),
  settings: none,
} satisfies Record<ArtifactBlockKind, z.ZodObject>

/** The text properties of each kind of block: checked like the content, changed under `ifRev`. */
export const artifactBlockTextPropsSchemas = {
  section: z.strictObject({ heading: artifactTextPropSchema.optional() }),
  frame: z.strictObject({
    name: artifactTextPropSchema.optional(),
    variant: oneLine(40).optional(),
    /** The address of its page when a canvas is published as a site: `/` or `/<segment>`. */
    path: z
      .string()
      .regex(/^\/(?:[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)?$/, 'a path "/" or "/<segment>"')
      .optional(),
  }),
  html: none,
  style: none,
  script: none,
  note: none,
  settings: none,
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

/**
 * The blocks that are HTML, CSS or JavaScript of a frame: a person's text of them passes the checks
 * of a page as written (`checkPageContent`, §7.3, Ар31); the agent's — the check of core.
 */
export const artifactPageBlockKinds: readonly ArtifactBlockKind[] = Object.freeze([
  'html',
  'style',
  'script',
])

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
 * headings from the third level; a frame holds nothing itself; `settings` is a JSON object; the
 * rest is text. Every block is at most `blockBytes`.
 */
export function artifactBlockContentProblem(
  kind: ArtifactBlockKind,
  content: string,
): ArtifactContentProblem | null {
  if (bytesOf(content) > artifactLimits.blockBytes) return 'too_large'
  switch (kind) {
    case 'section':
      return sectionMarkdownProblem(content)
    case 'frame':
      return content === '' ? null : 'not_empty'
    case 'note':
      return content.length > artifactLimits.commentChars ? 'too_large' : null
    case 'settings': {
      const value = jsonOf(content)
      if (value === undefined) return 'json'
      return jsonObject.safeParse(value).success ? null : 'shape'
    }
    default:
      return null
  }
}
