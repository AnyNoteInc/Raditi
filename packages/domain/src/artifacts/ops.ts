import { z } from 'zod'

import { secretInContent } from '../projects/text.ts'
import {
  artifactBlockKeySchema,
  artifactIntentSchema,
  artifactPropsSchema,
  artifactTitleSchema,
} from './blocks.ts'
import { artifactBlockKindSchema } from './kinds.ts'
import { artifactLimits } from './limits.ts'

/**
 * Operations on an artifact (docs/plan/88-artifacts.md, Ар14, Ар15, §7.2): one format for the
 * agent (`artifact_edit`) and the cabinet (`artifact.apply`). The server is the authority: these
 * schemas and checks are what may be asked; whether it applies — `ifRev`, holds, the quote on the
 * current text — is decided in the transaction of `@repo/db` with the rules below.
 */

const rev = z.number().int().min(0).max(2_147_483_647)
const after = artifactBlockKeySchema.nullable()

export const artifactInsertOpSchema = z.strictObject({
  op: z.literal('insert'),
  /** The block's own id by the rule of `section_key`; otherwise the server gives one. */
  block: artifactBlockKeySchema.optional(),
  after,
  parent: artifactBlockKeySchema.optional(),
  kind: artifactBlockKindSchema,
  content: z.string().optional(),
  props: artifactPropsSchema.optional(),
  intent: artifactIntentSchema.optional(),
})
export const artifactReplaceOpSchema = z.strictObject({
  op: z.literal('replace'),
  block: artifactBlockKeySchema,
  ifRev: rev,
  content: z.string(),
  /** Text properties (a heading, a name of a frame) change here, under `ifRev` (Ар15). */
  props: artifactPropsSchema.optional(),
})
export const artifactEditOpSchema = z.strictObject({
  op: z.literal('edit'),
  block: artifactBlockKeySchema,
  find: z.string().min(1).max(artifactLimits.blockBytes),
  replace: z.string().max(artifactLimits.blockBytes),
})
export const artifactMoveOpSchema = z.strictObject({
  op: z.literal('move'),
  block: artifactBlockKeySchema,
  ifRev: rev,
  after,
  parent: artifactBlockKeySchema.optional(),
})
export const artifactDeleteOpSchema = z.strictObject({
  op: z.literal('delete'),
  block: artifactBlockKeySchema,
  ifRev: rev,
})
/** Value properties only — numbers, enumerations, flags: «the last one wins» (Ар15). */
export const artifactPropsOpSchema = z.strictObject({
  op: z.literal('props'),
  block: artifactBlockKeySchema,
  props: artifactPropsSchema,
})
export const artifactTitleOpSchema = z.strictObject({
  op: z.literal('title'),
  title: artifactTitleSchema,
})

export const artifactOpSchema = z.discriminatedUnion('op', [
  artifactInsertOpSchema,
  artifactReplaceOpSchema,
  artifactEditOpSchema,
  artifactMoveOpSchema,
  artifactDeleteOpSchema,
  artifactPropsOpSchema,
  artifactTitleOpSchema,
])
export type ArtifactOp = z.infer<typeof artifactOpSchema>
export type ArtifactOpKind = ArtifactOp['op']

/** The id of a batch: a repeat with the same id and the same hash gets the same answer (Ар14). */
export const artifactOpIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

/** A batch as it comes. The array bound here is the widest one; the real one is `artifactBatchProblem`. */
export const artifactBatchSchema = z.strictObject({
  artifactId: z.uuid(),
  opId: artifactOpIdSchema,
  ops: z.array(artifactOpSchema).min(1).max(artifactLimits.batchJsonNodes),
})
export type ArtifactBatch = z.infer<typeof artifactBatchSchema>

/** The values of a JSON value: objects, arrays and every primitive; keys are not counted (§7.2). */
export function jsonNodeCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, item) => n + jsonNodeCount(item), 1)
  if (value !== null && typeof value === 'object')
    return Object.values(value).reduce<number>((n, item) => n + jsonNodeCount(item), 1)
  return 1
}

/**
 * Why a batch is refused before any row is read; null — it may go to the transaction.
 * - The JSON is at most 90 KiB and 4 000 values (`ARTIFACT_TOO_LARGE`).
 * - At most 50 operations, of the agent and of the cabinet alike.
 * - An id an `insert` gives is new within the batch; a parent or an anchor may name it.
 * - `edit` never replaces a quote by itself.
 */
export function artifactBatchProblem(
  batch: ArtifactBatch,
): { code: 'ARTIFACT_TOO_LARGE' | 'ARTIFACT_OP_INVALID'; problem: string } | null {
  const json = JSON.stringify(batch)
  if (new TextEncoder().encode(json).byteLength > artifactLimits.batchJsonBytes)
    return { code: 'ARTIFACT_TOO_LARGE', problem: 'batchJsonBytes' }
  if (jsonNodeCount(batch) > artifactLimits.batchJsonNodes)
    return { code: 'ARTIFACT_TOO_LARGE', problem: 'batchJsonNodes' }
  if (batch.ops.length > artifactLimits.batchOps)
    return { code: 'ARTIFACT_TOO_LARGE', problem: 'batchOps' }
  const given = new Set<string>()
  for (const op of batch.ops) {
    if (op.op === 'insert' && op.block !== undefined) {
      if (given.has(op.block))
        return { code: 'ARTIFACT_OP_INVALID', problem: `block ${op.block} is inserted twice` }
      given.add(op.block)
    }
    if (op.op === 'edit' && op.find === op.replace)
      return { code: 'ARTIFACT_OP_INVALID', problem: `edit of ${op.block} changes nothing` }
    if (op.op === 'title' && batch.ops.filter((other) => other.op === 'title').length > 1)
      return { code: 'ARTIFACT_OP_INVALID', problem: 'the title is set twice' }
  }
  return null
}

/** How many times a quote occurs in a text, overlapping occurrences counted. */
export function quoteOccurrences(text: string, find: string): number {
  if (find === '') return 0
  let count = 0
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + 1)) count += 1
  return count
}

export type ArtifactQuoteEdit =
  | { ok: true; text: string }
  | { ok: false; code: 'ARTIFACT_FIND_NONE' | 'ARTIFACT_FIND_MANY'; count: number }

/**
 * An edit by quote on the current text (Ар15): exactly one occurrence, overlapping ones counted —
 * «aa» in «aaa» is ambiguous. The replacement is taken literally.
 */
export function applyQuoteEdit(text: string, find: string, replace: string): ArtifactQuoteEdit {
  const count = quoteOccurrences(text, find)
  if (count === 0) return { ok: false, code: 'ARTIFACT_FIND_NONE', count }
  if (count > 1) return { ok: false, code: 'ARTIFACT_FIND_MANY', count }
  const at = text.indexOf(find)
  return { ok: true, text: text.slice(0, at) + replace + text.slice(at + find.length) }
}

/**
 * Every text a batch writes: contents, quotes' replacements, string properties, the title,
 * and intents. The check of core reads them for the agent's writes (Ар19); the
 * cabinet refuses a person's batch where one looks like a secret (`artifactBatchHasSecretShape`).
 */
export function artifactBatchTexts(batch: ArtifactBatch): string[] {
  const texts: string[] = []
  const strings = (record: Record<string, unknown> | undefined) => {
    for (const value of Object.values(record ?? {}))
      if (typeof value === 'string') texts.push(value)
  }
  for (const op of batch.ops) {
    switch (op.op) {
      case 'insert':
        if (op.content !== undefined) texts.push(op.content)
        if (op.intent !== undefined) texts.push(op.intent)
        strings(op.props)
        break
      case 'replace':
        texts.push(op.content)
        strings(op.props)
        break
      case 'edit':
        texts.push(op.replace)
        break
      case 'props':
        strings(op.props)
        break
      case 'title':
        texts.push(op.title)
        break
      case 'move':
      case 'delete':
        break
    }
  }
  return texts.filter((text) => text !== '')
}

/**
 * A person's write that carries the form of a secret is not kept (Ар19, `ARTIFACT_SECRET_SHAPE`).
 * The texts of the batch only: the transaction checks the block an `edit` leaves as well, since a
 * quote and its replacement may form a secret only together.
 */
export function artifactBatchHasSecretShape(batch: ArtifactBatch): boolean {
  return artifactBatchTexts(batch).some(secretInContent)
}
