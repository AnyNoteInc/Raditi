import { createHash } from 'node:crypto'

import { Logger } from '@nestjs/common'
import { extendTaskHolds } from '@repo/billing'
import {
  insertFeedEvent,
  nextCandidateRevision,
  recordCandidate,
  requestPreviewSync,
  supersedeStandingCandidate,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  addOnlyPathOf,
  AGENT_TURN_QUEUE,
  assertCandidatePath,
  CANDIDATE_EDIT_JOB,
  candidateEditDedupeKey,
  isDomainError,
  leaseLost,
  publicationForbidden,
  siteFileEditKey,
  siteFileEditLimits,
  siteFileEditSchema,
  taskHoldExpiry,
  terminalTaskStatuses,
  turnLeaseOf,
  workingSetMatcher,
  type CandidateEditJob,
  type FeedEditOutcome,
  type JobQueue,
  type ObjectStorage,
  type SiteAdapter,
  type SiteFileEdit,
  type SiteLeaseFence,
  type SiteLeaseStore,
  type SiteStack,
  type TaskStatus,
} from '@repo/domain'

import { standingCandidateOf, type CandidateBuilder } from './candidate-builder.ts'
import type { CandidateGit } from './candidate-git.ts'
import { siteFactsOf, workspaceRulesOf } from './pass-facts.ts'

/** An edit holds the chat this long at most: a clone, one commit and one push. */
const EDIT_LEASE_MS = 10 * 60_000
/** An agent at work, or a revision not recorded yet, is asked again after this. */
const RETRY_MS = 15_000
/** The edit's object at most: the view limit as JSON, every byte escaped at worst. */
const EDIT_BYTES = 6 * 256 * 1024 + 4096

/** Where the client may save a file: the agent waits for the client. */
const editable: readonly TaskStatus[] = ['awaiting_user', 'awaiting_approval']

export interface CandidateEditDependencies {
  db: PrismaClient
  /** Both null while git is not configured: nothing is saved. */
  git: CandidateGit | null
  candidates: CandidateBuilder | null
  leases: SiteLeaseStore
  queue: JobQueue
  /** The edits of the clients, as web put them (`siteFileEditKey`). */
  inbox: Pick<ObjectStorage, 'get' | 'delete'>
  /** The rules of a stack's workspace hold the path, as publication holds the agent's (rule 6). */
  adapter: (stack: SiteStack) => SiteAdapter
  logger?: { log(message: string): void; warn(message: string): void; error(message: string): void }
  now?: () => Date
}

export type EditAnswer = FeedEditOutcome | 'busy' | 'later' | 'nothing'

interface EditedTask {
  id: string
  siteId: string
  status: TaskStatus
  turnNo: number
  billable: boolean
  site: { stack: SiteStack; url: string; installedVersion: string | null }
}

/** Thrown inside a transaction to roll it back and put the job again. */
class Later extends Error {}

/** The id git gives the bytes of a file: what a pushed edit left at its path. */
const blobOid = (bytes: Uint8Array): string =>
  createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')

/**
 * The client's edit of a file in «Терминал» of a chat with the code (owner's request of
 * 06.11.2026: «при сохранении файл должен сохраняться в агента, а потом по возможности
 * комититься в гит»). Under the chat's own lease (`turnLeaseOf`) — so never beside a turn, an
 * «Обновить» or an `/undo` of the chat — and only while the agent waits for the client: while it
 * works the job waits too, up to `siteFileEditLimits.waitMs`. The file must not have changed in
 * the working copy since the client opened it (`conflict`), and the rules of the site's workspace
 * must let it change (`refused`, rule 6). Then the bot commits it to `agent/<taskId>` by CAS and
 * the next revision of the chat's changes is recorded with its preview to rebuild: the agent's
 * next turn starts from it, and `/release` takes it to the site (rule 3). Every final answer
 * leaves a `feed.edit` row; the text of the edit leaves the inbox with it.
 */
export class CandidateEdit {
  readonly #logger: {
    log(message: string): void
    warn(message: string): void
    error(message: string): void
  }
  readonly #now: () => Date

  constructor(private readonly deps: CandidateEditDependencies) {
    this.#logger = deps.logger ?? new Logger('CandidateEdit')
    this.#now = deps.now ?? (() => new Date())
  }

  async run(job: CandidateEditJob): Promise<EditAnswer> {
    if (await this.#answered(job)) return 'nothing'
    const edit = await this.#edit(job)
    if (!edit) {
      this.#logger.warn(`candidate_edit_lost task=${job.taskId} edit=${job.editId}`)
      return 'nothing'
    }
    const { git, candidates } = this.deps
    if (!git?.readFile || !git.commitFileEdit || !git.comparesCommits || !candidates)
      return this.#final(job, edit, 'failed')
    const task = await this.#task(job.taskId)
    if (!task || terminalTaskStatuses.includes(task.status) || task.turnNo < 1)
      return this.#final(job, edit, 'failed')
    if (!editable.includes(task.status)) return this.#wait(job, edit)
    const lease = await this.deps.leases.acquire({
      siteId: turnLeaseOf({ ...task, needsRepository: true }),
      taskId: task.id,
      operation: 'turn',
      ttlMs: EDIT_LEASE_MS,
    })
    if (!lease) return this.#wait(job, edit)
    try {
      return await this.#apply(job, edit, lease)
    } catch (error) {
      return this.#later(job, edit, error)
    } finally {
      await this.deps.leases.release(lease).catch(() => {
        this.#logger.warn(`candidate_edit_release_failed task=${job.taskId}`)
      })
    }
  }

  async #apply(job: CandidateEditJob, edit: SiteFileEdit, lease: SiteLeaseFence) {
    const { git, candidates } = this.deps
    const readFile = git?.readFile
    const commitFileEdit = git?.commitFileEdit
    if (!git || !readFile || !commitFileEdit || !candidates) return this.#final(job, edit, 'failed')
    // Read anew under the lease: a turn may have started before it.
    const task = await this.#task(job.taskId)
    if (!task || terminalTaskStatuses.includes(task.status) || task.turnNo < 1)
      return this.#final(job, edit, 'failed')
    if (!editable.includes(task.status)) return this.#wait(job, edit)
    const repository = await this.deps.db.gitRepository.findFirst({
      where: { siteId: task.siteId },
      orderBy: { createdAt: 'asc' },
      select: { provider: true, owner: true, name: true, defaultBranch: true },
    })
    if (!repository) return this.#final(job, edit, 'failed')
    const repo = { provider: repository.provider, owner: repository.owner, name: repository.name }
    const branch = `agent/${task.id}`
    const [main, head] = await Promise.all([
      git.readBranchHead({ repo, branch: repository.defaultBranch }),
      git.readBranchHead({ repo, branch }),
    ])
    if (!main) return this.#final(job, edit, 'failed')
    const current = head ?? main
    const content = Buffer.from(edit.text, 'utf8')

    const rules = workspaceRulesOf(this.deps.adapter(task.site.stack), siteFactsOf(task.site))
    const now = await readFile({ repo, sha: current, path: edit.path, maxBytes: 1 })
    const pushed = now?.oid === blobOid(content)
    try {
      assertCandidatePath(edit.path, {
        protectedPaths: rules.protectedPaths,
        inWorkingSet: rules.workingSet ? workingSetMatcher(rules.workingSet) : null,
        ...(rules.addOnlyPaths ? { addOnlyPaths: rules.addOnlyPaths } : {}),
        ...(rules.media ? { media: rules.media } : {}),
      })
      // The media library only grows (Р12): a file of it is added, never changed.
      if (now && !pushed && addOnlyPathOf(edit.path, rules.addOnlyPaths))
        throw publicationForbidden('Media under an add-only path may only be added')
    } catch (error) {
      if (isDomainError(error) && ruleCodes.has(error.code))
        return this.#final(job, edit, 'refused')
      throw error
    }
    // The file stands as the client opened it — or as this edit left it, pushed before a run
    // that could not record it.
    if (!pushed && edit.baseSha !== current) {
      const before = await readFile({
        repo,
        sha: edit.baseSha,
        path: edit.path,
        maxBytes: 1,
      }).catch(() => undefined)
      if (before === undefined || (before?.oid ?? null) !== (now?.oid ?? null))
        return this.#final(job, edit, 'conflict')
    }

    let headSha = current
    if (!pushed) {
      const push = await commitFileEdit(
        {
          repo,
          branch,
          parent: current,
          expected: head,
          path: edit.path,
          content,
          message: `Client edit: ${edit.path}`,
          committedAt: new Date(Math.floor(Date.parse(edit.savedAt) / 1000) * 1000).toISOString(),
        },
        async () => {
          if (!(await this.deps.leases.assert(lease))) throw leaseLost()
        },
      ).catch((error: unknown) => {
        // A link, a folder or a submodule at the path: no file to write there.
        if (isDomainError(error) && error.code === 'REPOSITORY_UNSUPPORTED') return null
        throw error
      })
      if (push === null) return this.#final(job, edit, 'refused')
      if (push.status === 'moved') return this.#final(job, edit, 'conflict')
      headSha = push.sha
    }

    const standing = await standingCandidateOf(this.deps.db, task.id)
    const revision = await nextCandidateRevision(this.deps.db, task.id)
    const context = await candidates.context(task, standing, revision, main)
    if (!context) return this.#final(job, edit, 'failed')
    const pass = { turnNo: task.turnNo, headSha, baseSha: context.base }
    const build = await candidates.build(context, { ...pass, claims: null })
    if (build.kind === 'unchanged')
      return this.#final(job, edit, 'saved', standing?.revision ?? null)
    if (!(await this.deps.leases.assert(lease))) throw leaseLost()
    if (build.kind === 'empty') {
      // The edit took the change back to the base: nothing is left to release.
      const carrier = candidates.carrier(context, pass, build)
      return this.#record(job, edit, task, async (tx) => {
        await recordCandidate(tx, carrier)
        await supersedeStandingCandidate(tx, task.id)
        await requestPreviewSync(tx, { taskId: task.id, revision: 0 })
        if (task.status === 'awaiting_approval')
          await tx.task.update({ where: { id: task.id }, data: { status: 'awaiting_user' } })
        return null
      })
    }
    if (build.kind !== 'candidate') return this.#final(job, edit, 'failed')
    const { record } = build
    return this.#record(job, edit, task, async (tx, at) => {
      await recordCandidate(tx, record)
      const turn = await tx.taskTurn.findUnique({
        where: { taskId_turnNo: { taskId: task.id, turnNo: task.turnNo } },
        select: { id: true },
      })
      await insertFeedEvent(tx, {
        taskId: task.id,
        turnId: turn?.id ?? null,
        row: {
          type: 'feed.candidate',
          payload: {
            v: 1,
            turn: task.turnNo,
            revision: record.revision,
            version: record.proposedVersion,
            bump: record.proposedBump,
            files: {
              added: record.facts.addedFiles,
              modified: record.facts.modifiedFiles,
              deleted: record.facts.deletedFiles,
            },
            media: record.facts.mediaFiles,
            records: record.dbPlan.length,
          },
        },
      })
      await requestPreviewSync(tx, { taskId: task.id, revision: record.revision })
      if (task.status === 'awaiting_user')
        await tx.task.update({ where: { id: task.id }, data: { status: 'awaiting_approval' } })
      if (task.billable)
        await extendTaskHolds(tx, { taskId: task.id, expiresAt: taskHoldExpiry(at, 'waiting') })
      return record.revision
    })
  }

  /**
   * The revision and its rows in one transaction, while the chat still waits as it did: a chat
   * the client wrote to meanwhile puts the job again, and the next run finds the edit pushed.
   */
  async #record(
    job: CandidateEditJob,
    edit: SiteFileEdit,
    task: EditedTask,
    work: (tx: Prisma.TransactionClient, at: Date) => Promise<number | null>,
  ): Promise<EditAnswer> {
    await this.deps.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM tasks
          WHERE id = ${task.id}::uuid AND status::text = ${task.status} AND turn_no = ${task.turnNo}
          FOR UPDATE`
        if (rows.length !== 1) throw new Later()
        const revision = await work(tx, this.#now())
        await this.#feed(tx, job, edit, 'saved', revision)
      },
      { isolationLevel: 'ReadCommitted', timeout: 30_000 },
    )
    await this.#forget(job)
    this.#logger.log(`candidate_edit_saved task=${job.taskId} edit=${job.editId}`)
    return 'saved'
  }

  /** The agent works, or the chat's lease is taken: the job waits, while the edit is young. */
  async #wait(job: CandidateEditJob, edit: SiteFileEdit): Promise<EditAnswer> {
    if (!this.#young(edit)) return this.#final(job, edit, 'failed')
    await this.#again(job)
    return 'busy'
  }

  async #later(job: CandidateEditJob, edit: SiteFileEdit, error: unknown): Promise<EditAnswer> {
    const code = isDomainError(error) ? error.code : error instanceof Later ? 'later' : 'error'
    if (!this.#young(edit)) {
      this.#logger.error(`candidate_edit_unrecorded task=${job.taskId} code=${code}`)
      return this.#final(job, edit, 'failed')
    }
    this.#logger.warn(`candidate_edit_later task=${job.taskId} code=${code}`)
    await this.#again(job)
    return 'later'
  }

  #young(edit: SiteFileEdit): boolean {
    return this.#now().getTime() - Date.parse(edit.savedAt) <= siteFileEditLimits.waitMs
  }

  async #again(job: CandidateEditJob): Promise<void> {
    await this.deps.queue
      .enqueue(AGENT_TURN_QUEUE, CANDIDATE_EDIT_JOB, job, {
        jobId: `${candidateEditDedupeKey(job)}:retry:${this.#now().getTime()}`,
        delayMs: RETRY_MS,
      })
      .catch(() => this.#logger.warn(`candidate_edit_requeue_failed task=${job.taskId}`))
  }

  /** A final answer other than `saved`: its row, and the text leaves the inbox. */
  async #final(
    job: CandidateEditJob,
    edit: SiteFileEdit,
    outcome: FeedEditOutcome,
    revision: number | null = null,
  ): Promise<EditAnswer> {
    await this.#feed(this.deps.db, job, edit, outcome, revision)
    await this.#forget(job)
    this.#logger.log(`candidate_edit_${outcome} task=${job.taskId} edit=${job.editId}`)
    return outcome
  }

  async #feed(
    db: Pick<Prisma.TransactionClient, 'taskEvent'>,
    job: CandidateEditJob,
    edit: SiteFileEdit,
    outcome: FeedEditOutcome,
    revision: number | null,
  ): Promise<void> {
    await insertFeedEvent(db, {
      taskId: job.taskId,
      row: {
        type: 'feed.edit',
        payload: { v: 1, editId: job.editId, path: edit.path, outcome, revision },
      },
    })
  }

  /** The edit has its row already: a job put twice answers once. */
  async #answered(job: CandidateEditJob): Promise<boolean> {
    const rows = await this.deps.db.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM task_events
      WHERE task_id = ${job.taskId}::uuid AND type = 'feed.edit'
        AND payload->>'editId' = ${job.editId}
      LIMIT 1`
    return rows.length > 0
  }

  async #edit(job: CandidateEditJob): Promise<SiteFileEdit | null> {
    const body = await this.deps.inbox.get('inbox', siteFileEditKey(job.taskId, job.editId))
    if (body === null) return null
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of body) {
      size += chunk.byteLength
      if (size > EDIT_BYTES) return null
      chunks.push(Buffer.from(chunk))
    }
    let raw: unknown
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return null
    }
    const parsed = siteFileEditSchema.safeParse(raw)
    return parsed.success && parsed.data.taskId === job.taskId ? parsed.data : null
  }

  async #forget(job: CandidateEditJob): Promise<void> {
    await this.deps.inbox
      .delete('inbox', siteFileEditKey(job.taskId, job.editId))
      .catch(() => this.#logger.warn(`candidate_edit_forget_failed task=${job.taskId}`))
  }

  async #task(taskId: string): Promise<EditedTask | null> {
    const task = await this.deps.db.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        siteId: true,
        status: true,
        turnNo: true,
        billable: true,
        needsRepository: true,
        site: { select: { stack: true, url: true, installedVersion: true } },
      },
    })
    if (!task || !task.siteId || !task.site || !task.needsRepository) return null
    return { ...task, siteId: task.siteId, site: task.site }
  }
}

/** The refusals of the rules of a workspace (`assertCandidatePath`). */
const ruleCodes = new Set(['PUBLICATION_FORBIDDEN'])
