import { createHash, randomUUID } from 'node:crypto'

import {
  DomainError,
  isOptionRef,
  isOptionState,
  isRecordState,
  isTableState,
  publishedObjectRefSchema,
  type DbPlan,
  type DbWriteChange,
  type PreviewContentRecipe,
  type PreviewRuntime,
  type PublishedContentPatch,
  type SiteContentGateway,
  type SiteContentAdapter,
} from '@repo/domain'
import { z } from 'zod'

import type { DbPlanValueOwner, DbPlanValueReader } from '../site-content/db-plan-values.ts'

// The content of a preview through the stack's own plugin (docs/plan/53-chat-preview-release.md,
// Р15, Р22, Р24): the platform's account of the copy, the comparison of the seed with production
// and the replay of a candidate's database plan. What a command prints is the stack's; core only
// reads it through the adapter's schemas.

/** How long a command of the CLI container may run. */
const COMMAND_MS = 120_000
/** Objects compared with production after a seed, side by side. */
const CHECK_PARALLEL = 6
/** The most objects a seed is compared on; beyond them nothing is editable. */
export const SEED_CHECK_OBJECTS = 5_000

export const previewContentFailure = (code: string) =>
  new DomainError(
    'PREVIEW_CONTENT_FAILED',
    'The content of the preview could not be prepared',
    502,
    {
      code,
    },
  )

async function runJson(
  runtime: Pick<PreviewRuntime, 'exec'>,
  previewId: string,
  argv: readonly string[],
  signal: AbortSignal,
  code: string,
): Promise<unknown> {
  const result = await runtime.exec(previewId, { argv: [...argv], timeoutMs: COMMAND_MS }, signal)
  if (result.code !== 0) throw previewContentFailure(code)
  try {
    return JSON.parse(Buffer.from(result.stdout).toString('utf8').trim()) as unknown
  } catch {
    throw previewContentFailure(code)
  }
}

/**
 * The platform's account of the preview's copy: what the stack's command printed, the origin of
 * the preview added, as the stack's content access — what `kv/previews/<previewId>/wp` keeps.
 */
export async function previewContentAccess(
  input: {
    runtime: Pick<PreviewRuntime, 'exec'>
    previewId: string
    recipe: PreviewContentRecipe
    adapter: Pick<SiteContentAdapter, 'accessSchema'>
    origin: string
  },
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const printed = await runJson(
    input.runtime,
    input.previewId,
    input.recipe.access,
    signal,
    'access',
  )
  const flat = z.record(z.string(), z.string()).safeParse(printed)
  if (!flat.success || Object.hasOwn(flat.data, 'origin')) throw previewContentFailure('access')
  const access = input.adapter.accessSchema.safeParse({ ...flat.data, origin: input.origin })
  if (!access.success) throw previewContentFailure('access')
  return { ...flat.data, origin: input.origin }
}

/** The published objects of the copy the plugin edits. */
export async function previewContentObjects(
  input: { runtime: Pick<PreviewRuntime, 'exec'>; previewId: string; recipe: PreviewContentRecipe },
  signal: AbortSignal,
): Promise<string[]> {
  const printed = await runJson(
    input.runtime,
    input.previewId,
    input.recipe.objects,
    signal,
    'objects',
  )
  const refs = z.array(publishedObjectRefSchema).max(SEED_CHECK_OBJECTS).safeParse(printed)
  if (!refs.success) throw previewContentFailure('objects')
  return [...new Set(refs.data)]
}

/**
 * The objects whose state in the seed differs from production (Р15): the plugin's hash on both
 * sides, object by object. One production cannot answer for, or the preview cannot, is counted
 * as differing: what is not known equal is not editable.
 */
export async function seedMismatches(
  input: {
    production: SiteContentGateway
    preview: SiteContentGateway
    objects: readonly string[]
  },
  signal: AbortSignal,
): Promise<string[]> {
  const differing: string[] = []
  const queue = [...input.objects]
  const worker = async () => {
    for (let ref = queue.shift(); ref !== undefined; ref = queue.shift()) {
      signal.throwIfAborted()
      // A setting of the list is read through the plugin's objects of a plan, a record as ever.
      const read = (gateway: SiteContentGateway) =>
        (isOptionRef(ref)
          ? (gateway.db?.readObject(ref) ?? Promise.reject(new Error('no objects of a plan')))
          : gateway.read(ref)
        ).catch(() => null)
      const [live, copy] = await Promise.all([read(input.production), read(input.preview)])
      if (!live || !copy || live.stateHash !== copy.stateHash) differing.push(ref)
    }
  }
  await Promise.all(Array.from({ length: CHECK_PARALLEL }, worker))
  return differing.sort()
}

/**
 * Writes a candidate's compacted plan into the preview's fresh copy (Р22, «Операции БД и
 * миграции»): in the one order of a plan, each object goes from the state the plan starts at to
 * the one it ends at, with that start as the precondition and in the plugin's exact-bytes mode
 * `restore` — a table by the dictionary, a setting by its exact bytes, a created record under its
 * own id of the plan and with the mark of the call that created it. Anything else — a conflict,
 * a refused value, a receipt of another state — stops the rebuild: the preview never shows a plan
 * it does not hold.
 */
export async function replayDbPlan(
  input: {
    gateway: SiteContentGateway
    plan: DbPlan
    values: DbPlanValueReader
    owner: DbPlanValueOwner
    previewId: string
    /** `preview_environments.write_epoch` of the build: the plugin's fence, as the mcp role's. */
    epoch: number
  },
  signal: AbortSignal,
): Promise<void> {
  const conflicted = () => previewContentFailure('plan_conflict')
  for (const operation of input.plan) {
    signal.throwIfAborted()
    const read = (side: 'before' | 'after') =>
      input.values.readState(input.owner, operation.objectRef, side, operation[side])
    const callId = randomUUID()
    const ttlMs = 60_000
    const envelope = {
      callId,
      siteId: input.previewId,
      epoch: input.epoch,
      requestHash: createHash('sha256')
        .update(JSON.stringify(['preview-replay', input.previewId, operation.objectRef, callId]))
        .digest('hex'),
      objectRef: operation.objectRef,
      expectedStateHash: operation.beforeHash,
      deadlineAt: Date.now() + ttlMs,
      ttlMs,
      mode: 'restore' as const,
    }
    let outcome: { kind: string; stateHash?: string; createdRef?: string }
    if (operation.kind === 'content_update') {
      const { state: after } = await read('after')
      if (!isRecordState(after)) throw conflicted()
      const fields: PublishedContentPatch = {}
      for (const field of operation.fields) fields[field] = after[field]
      outcome = await input.gateway.conditionalWrite({ ...envelope, fields })
    } else {
      const db = input.gateway.db
      if (!db) throw conflicted()
      const [before, after] = await Promise.all([read('before'), read('after')])
      let change: DbWriteChange
      if (operation.kind === 'option_update') {
        if (!isOptionState(after.state)) throw conflicted()
        change = { kind: 'option_update', value: after.state.value }
      } else if (operation.kind === 'post_create') {
        const record = after.state
        if (!isRecordState(record) || !record.slug) throw conflicted()
        change = {
          kind: 'post_create',
          record: {
            status: record.status ?? 'publish',
            slug: record.slug,
            title: record.title,
            content: record.content,
            excerpt: record.excerpt,
          },
          // The `before` of a creation is the call that created it: its mark stays the same.
          createCallId: before.callId,
        }
      } else {
        const [from, to] = [before.state, after.state]
        if (!isTableState(from) || !isTableState(to)) throw conflicted()
        change = {
          kind: 'schema_migration',
          before: { exists: from.exists, managed: from.managed, definition: from.definition },
          definition: to.definition,
        }
      }
      outcome = await db.writeObject({ ...envelope, change })
    }
    if (
      outcome.kind !== 'committed' ||
      outcome.stateHash !== operation.afterHash ||
      (operation.kind === 'post_create' && outcome.createdRef !== operation.objectRef)
    )
      throw conflicted()
  }
}
