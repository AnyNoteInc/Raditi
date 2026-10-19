import { createHash } from 'node:crypto'

import { Logger } from '@nestjs/common'
import {
  failUndoPlan,
  recordUndoPlan,
  releaseWritingAttempt,
  wakeUndoPlan,
  type PrismaClient,
} from '@repo/db'
import {
  addOnlyPathOf,
  canonicalDbUndoPlanJson,
  classifyUndoOperation,
  dbPlanSchema,
  dbStateHashMaterial,
  isAbsentState,
  isDomainError,
  isOptionState,
  isRecordState,
  undoFilesSummarySchema,
  undoOperationOf,
  undoPlanMaterial,
  UNDO_SUMMARY_PATHS,
  type DbObjectState,
  type DbOperation,
  type DbUndoOperation,
  type ReleaseUndoPlanJob,
  type SiteAdapter,
  type SiteContentGateway,
  type SiteStack,
  type UndoFilesSummary,
  type UndoItemVerdict,
  type UndoPlanError,
  type UndoPlanItem,
} from '@repo/domain'

import { absentHashOf, contentCallId, createdHashOf } from '../deploy-step/content.ts'
import type { ReleaseGit } from '../git-workspace/release-git.ts'
import { publishedValueRefusal } from '../mcp/published-value.ts'
import type { DbPlanValueReader } from './release-db-values.ts'
import { installedBaseOf, siteRepository } from './release-row.ts'
import type { ProductionContent } from './release-skill.ts'

// The plan of «Отменить выпуск» (docs/plan/53-chat-preview-release.md, «Отмена выпуска»): what
// undoing the release a site runs would do, worked out by core — web reads neither git nor
// production. Files: the version before the release, with the media it added kept. Records:
// each object of the release's plan read on production through its plugin, each hash worked out
// again from its fields — what still holds what the release wrote goes back (a new record of the
// release to the trash, at the reference production gave it, found by the receipt of the write
// that created it), what the site changed since stays and is named, a table stays. The values the
// undo would write are read and checked against their hashes too; none is kept in the plan.

/** A plan that cannot be made yet is asked again this long after, up to UNDO_PLAN_RETRY_MS. */
export const UNDO_PLAN_RETRY_DELAY_MS = 10_000
/** After this long from its request a plan that could not be made fails: the window asks again. */
export const UNDO_PLAN_RETRY_MS = 60_000

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A step outside PostgreSQL did not answer: the plan is asked again, then fails with `code`. */
class NotYet extends Error {
  constructor(readonly code: UndoPlanError) {
    super(`The plan of the undo waits: ${code}`)
  }
}

export interface UndoPlannerDependencies {
  db: PrismaClient
  git: Pick<ReleaseGit, 'changeDigests' | 'treeOf' | 'treeWith'> | null
  production: ProductionContent | null
  values: DbPlanValueReader | null
  adapter: (stack: SiteStack) => Pick<SiteAdapter, 'mediaRules'>
  /** PREVIEW_BASE_DOMAIN: a value naming any preview is not written back to production. */
  previewBaseDomain: string | null
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

/** The release undone, as the planner reads it. */
interface Undone {
  id: string
  siteId: string
  taskId: string
  workspaceId: string
  stack: SiteStack
  url: string
  approvedSha: string
  installedBeforeSha: string | null
  mainBeforeSha: string
  dbPlan: unknown
}

export class UndoPlanner {
  readonly #logger: NonNullable<UndoPlannerDependencies['logger']>
  readonly #now: () => Date

  constructor(private readonly deps: UndoPlannerDependencies) {
    this.#logger = deps.logger ?? new Logger('UndoPlanner')
    this.#now = deps.now ?? (() => new Date())
  }

  async plan(job: Pick<ReleaseUndoPlanJob, 'planId'>): Promise<void> {
    const { db } = this.deps
    const plan = await db.releaseUndoPlan.findUnique({
      where: { id: job.planId },
      select: { id: true, status: true, releaseId: true, installedSha: true, createdAt: true },
    })
    if (plan?.status !== 'pending') return
    const release = await db.siteRelease.findUnique({
      where: { id: plan.releaseId },
      select: {
        id: true,
        kind: true,
        status: true,
        siteId: true,
        taskId: true,
        approvedSha: true,
        installedBeforeSha: true,
        mainBeforeSha: true,
        candidate: { select: { dbPlan: true } },
        task: { select: { workspaceId: true } },
        site: { select: { stack: true, url: true, installedReleaseId: true, installedSha: true } },
      },
    })
    // Only the release the site runs now, against the commit the plan was asked for.
    if (
      release?.kind !== 'release' ||
      release.status !== 'installed' ||
      release.approvedSha === null ||
      release.approvedSha !== plan.installedSha ||
      release.site.installedReleaseId !== release.id ||
      release.site.installedSha !== plan.installedSha ||
      release.candidate === null
    ) {
      await failUndoPlan(db, { planId: plan.id, code: 'undo_outdated' })
      return
    }
    const undone: Undone = {
      id: release.id,
      siteId: release.siteId,
      taskId: release.taskId,
      workspaceId: release.task.workspaceId,
      stack: release.site.stack as SiteStack,
      url: release.site.url,
      approvedSha: release.approvedSha,
      installedBeforeSha: release.installedBeforeSha,
      mainBeforeSha: release.mainBeforeSha,
      dbPlan: release.candidate.dbPlan,
    }
    try {
      const files = await this.#files(undone)
      const records = await this.#records(undone)
      const dbPlanJson = canonicalDbUndoPlanJson(records.writes)
      const planSha256 = sha256(
        undoPlanMaterial({
          releaseId: undone.id,
          installedSha: undone.approvedSha,
          targetTree: files.targetTree,
          files: files.summary,
          items: records.items,
          dbPlanJson,
        }),
      )
      const nothingToUndo =
        files.summary.back + files.summary.removed + files.summary.restored === 0 &&
        records.writes.length === 0
      const recorded = await db.$transaction(async (tx) => {
        // Written only while the site still runs the release and no release goes on: a plan made
        // across a release would show what is no longer there.
        const site = await tx.$queryRaw<Array<{ fits: boolean }>>`
          SELECT s.installed_release_id = ${undone.id}::uuid
            AND s.installed_sha = ${undone.approvedSha}
            AND COALESCE(l.inflight_release_id IS NULL, true) AS fits
          FROM sites s LEFT JOIN site_leases l ON l.site_id = s.id
          WHERE s.id = ${undone.siteId}::uuid
          FOR SHARE OF s`
        if (site[0]?.fits !== true) {
          await failUndoPlan(tx, { planId: plan.id, code: 'site_busy' })
          return false
        }
        return recordUndoPlan(tx, {
          planId: plan.id,
          targetTree: files.targetTree,
          files: files.summary,
          items: records.items,
          dbPlan: records.writes,
          nothingToUndo,
          planSha256,
        })
      })
      if (recorded)
        this.#logger.log(
          `undo_plan_ready plan=${plan.id} release=${undone.id} writes=${records.writes.length}`,
        )
    } catch (error) {
      const code = error instanceof NotYet ? error.code : 'technical'
      const age = this.#now().getTime() - plan.createdAt.getTime()
      if (error instanceof NotYet && age < UNDO_PLAN_RETRY_MS) {
        this.#logger.warn(`undo_plan_later plan=${plan.id} reason=${code}`)
        await db.$transaction((tx) =>
          wakeUndoPlan(tx, {
            planId: plan.id,
            availableAt: new Date(this.#now().getTime() + UNDO_PLAN_RETRY_DELAY_MS),
          }),
        )
        return
      }
      if (!(error instanceof NotYet)) this.#logger.warn(`undo_plan_failed plan=${plan.id}`)
      await failUndoPlan(db, { planId: plan.id, code })
    }
  }

  /**
   * The files of the undo: what the release changed against the version before it goes back —
   * changed files to their content then, added ones away, deleted ones back —, except the media it
   * added, which stay. The tree of the undo commit is that version's with those media.
   */
  async #files(undone: Undone): Promise<{ summary: UndoFilesSummary; targetTree: string }> {
    const git = this.deps.git
    const repository = await siteRepository(this.deps.db, undone.siteId)
    if (!git || !repository) throw new NotYet('repository')
    const returnsTo = installedBaseOf(undone)
    const site = { stack: undone.stack, url: undone.url, docroot: '/', extras: {} }
    let addOnlyPaths: readonly string[] = []
    try {
      addOnlyPaths = this.deps.adapter(undone.stack).mediaRules(site).addOnlyPaths
    } catch (error) {
      if (!isDomainError(error) || error.code !== 'NOT_IMPLEMENTED') throw error
    }
    const changes = await this.#git(() =>
      git.changeDigests({ repo: repository.repo, baseSha: returnsTo, headSha: undone.approvedSha }),
    )
    const keep: string[] = []
    const listed: UndoFilesSummary['paths'] = []
    const summary = { back: 0, removed: 0, restored: 0, mediaKept: 0 }
    for (const change of [...changes].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      if (change.change === 'added' && addOnlyPathOf(change.path, addOnlyPaths) !== undefined) {
        keep.push(change.path)
        summary.mediaKept += 1
        continue
      }
      const undo =
        change.change === 'modified' ? 'back' : change.change === 'added' ? 'removed' : 'restored'
      summary[undo] += 1
      if (listed.length < UNDO_SUMMARY_PATHS) listed.push({ path: change.path, change: undo })
    }
    const targetTree = await this.#git(() =>
      keep.length > 0
        ? git.treeWith({
            repo: repository.repo,
            treeOf: returnsTo,
            overlay: { from: undone.approvedSha, paths: keep },
          })
        : git.treeOf({ repo: repository.repo, sha: returnsTo }),
    )
    return { summary: undoFilesSummarySchema.parse({ ...summary, paths: listed }), targetTree }
  }

  /**
   * The verdict of each object of the release's plan, in its order, and the writes of the undo,
   * in the reverse one: only objects production still holds as the release left them, whose
   * values before the release are kept and verify.
   */
  async #records(undone: Undone): Promise<{ items: UndoPlanItem[]; writes: DbUndoOperation[] }> {
    const parsed = dbPlanSchema.safeParse(undone.dbPlan)
    if (!parsed.success) throw new Error('The plan of the release does not read')
    const plan = parsed.data
    if (plan.length === 0) return { items: [], writes: [] }
    const production = this.deps.production
    if (!production) throw new NotYet('site_unreachable')
    let gateway: SiteContentGateway
    try {
      gateway = await production({
        workspaceId: undone.workspaceId,
        siteId: undone.siteId,
        stack: undone.stack,
        url: undone.url,
      })
    } catch {
      throw new NotYet('site_unreachable')
    }
    const writing = await releaseWritingAttempt(this.deps.db, { releaseId: undone.id })
    const items: UndoPlanItem[] = []
    const writes: DbUndoOperation[] = []
    for (const operation of plan) {
      const item = await this.#item(undone, gateway, operation, writing)
      items.push(item.item)
      if (item.write) writes.push(item.write)
    }
    return { items, writes: writes.reverse() }
  }

  async #item(
    undone: Undone,
    gateway: SiteContentGateway,
    operation: DbOperation,
    writing: number | null,
  ): Promise<{ item: UndoPlanItem; write: DbUndoOperation | null }> {
    const item = (verdict: UndoItemVerdict, productionRef: string | null = null) => ({
      objectRef: operation.objectRef,
      productionRef,
      kind: operation.kind,
      fields: [...operation.fields],
      verdict,
    })
    if (operation.kind === 'schema_migration') return { item: item('stays'), write: null }
    const db = gateway.db
    if (operation.kind === 'post_create') {
      // The record production gave the creation, by the receipt of the write that made it; no
      // receipt — nothing is taken out by a guess.
      if (!db || writing === null) return { item: item('missing'), write: null }
      const proof = await this.#production(() =>
        db.operation(contentCallId(undone.id, writing, operation.objectRef, 'apply')),
      )
      if (
        proof?.kind !== 'committed' ||
        !proof.createdRef ||
        proof.objectRef !== operation.objectRef
      )
        return { item: item('missing'), write: null }
      const productionRef = proof.createdRef
      const current = await this.#read(() => db.readObject(productionRef))
      const dependents =
        current !== null && current !== 'absent' && current.stateHash === proof.stateHash
          ? await this.#production(() => db.dependents(productionRef))
          : 0
      let verdict =
        current === null
          ? 'changed'
          : classifyUndoOperation({
              kind: operation.kind,
              written: proof.stateHash,
              prior: absentHashOf(productionRef),
              current: current === 'absent' ? 'absent' : current.stateHash,
              dependents,
            })
      // The address the trash checks: the creation as the release wrote it, re-keyed under the
      // reference production gave it, must be the state of the receipt.
      if (verdict === 'return') {
        const created = await this.#value(undone, operation.objectRef, 'after', operation)
        if (
          created === null ||
          !isRecordState(created) ||
          created.slug === undefined ||
          createdHashOf(productionRef, {
            status: created.status ?? 'publish',
            slug: created.slug,
            title: created.title,
            content: created.content,
            excerpt: created.excerpt,
          }) !== proof.stateHash
        )
          verdict = 'no_value'
        // The hash of a record leaves its address out: an address someone changed after the
        // release is a change of the page like any other, and the page stays.
        else if (
          current === null ||
          current === 'absent' ||
          !isRecordState(current) ||
          current.slug !== created.slug
        )
          verdict = 'changed'
      }
      return {
        item: item(verdict, productionRef),
        write:
          verdict === 'return'
            ? undoOperationOf(operation, {
                productionRef,
                stateHash: proof.stateHash,
                absentHash: absentHashOf(productionRef),
              })
            : null,
      }
    }
    const current = await this.#read(() =>
      operation.kind === 'content_update'
        ? gateway.read(operation.objectRef)
        : db
          ? db.readObject(operation.objectRef)
          : Promise.reject(new Error('No database part')),
    )
    let verdict =
      current === null
        ? 'changed'
        : classifyUndoOperation({
            kind: operation.kind,
            written: operation.afterHash,
            prior: operation.beforeHash,
            current: current === 'absent' ? 'absent' : current.stateHash,
          })
    if (verdict === 'return') {
      const prior = await this.#value(undone, operation.objectRef, 'before', operation)
      if (prior === null || !this.#writable(operation, prior)) verdict = 'no_value'
    }
    return {
      item: item(verdict),
      write: verdict === 'return' ? undoOperationOf(operation) : null,
    }
  }

  /**
   * One side of an operation of the release, as the journal of its preview keeps it, checked: its
   * hash is the hash of its fields and the hash the plan names. null — gone or not that value.
   */
  async #value(
    undone: Undone,
    objectRef: string,
    side: 'before' | 'after',
    operation: DbOperation,
  ): Promise<DbObjectState | null> {
    const reader = this.deps.values
    if (!reader) return null
    let state: DbObjectState
    try {
      state = (
        await reader.readState(
          { workspaceId: undone.workspaceId, taskId: undone.taskId },
          objectRef,
          side,
          operation[side],
        )
      ).state
    } catch (error) {
      if (isDomainError(error) && error.httpStatus === 409) return null
      throw new NotYet('technical')
    }
    const expected = side === 'after' ? operation.afterHash : operation.beforeHash
    return sha256(dbStateHashMaterial(state)) === state.stateHash && state.stateHash === expected
      ? state
      : null
  }

  /** A text or a setting the undo may write back: nothing a preview could have planted. */
  #writable(operation: DbOperation, prior: DbObjectState): boolean {
    const texts =
      operation.kind === 'content_update' && isRecordState(prior)
        ? operation.fields.map((field) => prior[field])
        : operation.kind === 'option_update' && isOptionState(prior)
          ? prior.value === null
            ? []
            : [prior.value]
          : null
    if (texts === null) return false
    const previews = { baseDomain: this.deps.previewBaseDomain }
    return texts.every((text) => publishedValueRefusal(text, previews) === null)
  }

  /**
   * The state of an object on production, its hash worked out again from its fields; `absent` —
   * not there; null — there, but no longer a public record the plugin may read (changed).
   */
  async #read(read: () => Promise<DbObjectState>): Promise<DbObjectState | 'absent' | null> {
    let state: DbObjectState
    try {
      state = await read()
    } catch (error) {
      if (isDomainError(error) && error.code === 'CONTENT_OBJECT_UNAVAILABLE') return null
      throw new NotYet('site_unreachable')
    }
    if (sha256(dbStateHashMaterial(state)) !== state.stateHash) return null
    return isAbsentState(state) ? 'absent' : state
  }

  async #production<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch {
      throw new NotYet('site_unreachable')
    }
  }

  async #git<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch {
      throw new NotYet('repository')
    }
  }
}
