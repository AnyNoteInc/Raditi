import { Prisma, type PrismaClient } from '@repo/db'
import {
  candidateFilesSchema,
  dbPlanSchema,
  terminalTaskStatuses,
  type CandidateFiles,
  type DbPlan,
  type PreviewDbMode,
  type PreviewStatus,
  type RepoRef,
  type SiteStack,
  type TaskStatus,
} from '@repo/domain'

import { previewRecordOf, type PreviewRecord } from './preview-record.ts'

// What the manager of previews knows of one preview when it acts (docs/plan/53, R5c): the row,
// its dialog, its site and the candidate it should show — read from PostgreSQL each time, never
// from the payload of a job.

/**
 * The last moment a preview was used, of the row `p` (owner's answer of 26.10.2026: a preview no
 * one used for PREVIEW_IDLE_MINUTES stops): its making, a view — a ticket, a session of the
 * gateway (checked again at most every 60 s while pages are asked), an open of a stopped one —
 * and a turn of its dialog, started or ended. A turn that runs now is not counted here: a pass
 * of the dialog holds its preview by the status of the task.
 */
export const previewLastUseSql = Prisma.sql`GREATEST(
  p.created_at,
  p.last_viewed_at,
  (SELECT max(k.created_at) FROM preview_tickets k WHERE k.preview_id = p.id),
  (SELECT max(GREATEST(s.created_at, s.checked_at)) FROM preview_sessions s
    WHERE s.preview_id = p.id),
  (SELECT max(GREATEST(u.started_at, u.finished_at)) FROM task_turns u WHERE u.task_id = p.task_id)
)`

export interface PreviewFacts {
  preview: {
    id: string
    siteId: string
    taskId: string
    status: PreviewStatus
    dbMode: PreviewDbMode
    unavailableReason: string | null
    hostname: string
    candidateId: string | null
    filesSha: string | null
    revision: number
    dirty: boolean
    upstream: { host: string; port: number } | null
    writeEpoch: number
    seed: { key: string; sha256: string; releaseId: string | null } | null
    expiresAt: Date
    lastViewedAt: Date | null
    /** The last moment it was used (`previewLastUseSql`). */
    lastUsedAt: Date
    record: PreviewRecord
    /**
     * A content write of the mcp role landed in the preview since it was built — at its current
     * write epoch (R7: `preview_db_operations` of a call admitted at `write_epoch`). The preview
     * shows what its candidate does not, until a rebuild replays the plan alone (Р22).
     */
    written: boolean
  }
  task: { status: TaskStatus; workspaceId: string; dataClass: 'synthetic' | 'client' }
  site: { id: string; stack: SiteStack; url: string; installedReleaseId: string | null }
  repo: (RepoRef & { defaultBranch: string }) | null
  /** The candidate the preview should show: the dialog's `current` or `stale` one. */
  candidate: {
    id: string
    revision: number
    headSha: string
    files: CandidateFiles
    dbPlan: DbPlan
    /** Its files or its plan do not read back: a build to it fails (`plan_invalid`). */
    invalid: boolean
  } | null
  /** The site has an access to its database (Р4), or a dump its copy is made from. */
  hasDatabase: boolean
  /**
   * The path of the SQL dump on the site's file source the copy is made from (owner's decision
   * of 26.10.2026), relative to its login folder; null — none is named. A live database wins.
   */
  databaseDump: string | null
}

export async function loadPreviewFacts(
  db: PrismaClient,
  previewId: string,
): Promise<PreviewFacts | null> {
  const row = await db.previewEnvironment.findUnique({
    where: { id: previewId },
    select: {
      id: true,
      siteId: true,
      taskId: true,
      status: true,
      dbMode: true,
      unavailableReason: true,
      hostname: true,
      candidateId: true,
      filesSha: true,
      revision: true,
      dirty: true,
      upstreamHost: true,
      upstreamPort: true,
      writeEpoch: true,
      seedObjectKey: true,
      seedSha256: true,
      seedReleaseId: true,
      expiresAt: true,
      lastViewedAt: true,
      runtime: true,
      task: {
        select: { status: true, workspaceId: true, workspace: { select: { dataClass: true } } },
      },
      site: { select: { id: true, stack: true, url: true, installedReleaseId: true } },
    },
  })
  if (!row) return null
  const [repository, candidate, database, access, written, dump, used] = await Promise.all([
    db.gitRepository.findFirst({
      where: { siteId: row.siteId },
      orderBy: { createdAt: 'asc' },
      select: { provider: true, owner: true, name: true, defaultBranch: true },
    }),
    db.taskCandidate.findFirst({
      where: { taskId: row.taskId, status: { in: ['current', 'stale'] } },
      orderBy: { revision: 'desc' },
      select: { id: true, revision: true, headSha: true, files: true, dbPlan: true },
    }),
    db.siteDatabase.findUnique({ where: { siteId: row.siteId }, select: { siteId: true } }),
    db.credentialRef.findFirst({ where: { siteId: row.siteId, kind: 'db' }, select: { id: true } }),
    db.previewDbOperation.findFirst({
      where: { previewId: row.id, mcpCall: { previewWriteEpoch: row.writeEpoch } },
      select: { id: true },
    }),
    db.siteDatabaseDump.findUnique({ where: { siteId: row.siteId }, select: { path: true } }),
    db.$queryRaw<Array<{ at: Date }>>`
      SELECT ${previewLastUseSql} AS at FROM preview_environments p WHERE p.id = ${row.id}::uuid`,
  ])
  const live = database !== null || access !== null
  const files = candidate ? candidateFilesSchema.safeParse(candidate.files) : null
  const dbPlan = candidate ? dbPlanSchema.safeParse(candidate.dbPlan) : null
  return {
    preview: {
      id: row.id,
      siteId: row.siteId,
      taskId: row.taskId,
      status: row.status,
      dbMode: row.dbMode,
      unavailableReason: row.unavailableReason,
      hostname: row.hostname,
      candidateId: row.candidateId,
      filesSha: row.filesSha,
      revision: row.revision,
      dirty: row.dirty,
      upstream:
        row.upstreamHost && row.upstreamPort
          ? { host: row.upstreamHost, port: row.upstreamPort }
          : null,
      writeEpoch: row.writeEpoch,
      seed:
        row.seedObjectKey && row.seedSha256
          ? { key: row.seedObjectKey, sha256: row.seedSha256, releaseId: row.seedReleaseId }
          : null,
      expiresAt: row.expiresAt,
      lastViewedAt: row.lastViewedAt,
      // The row was just read, so its moment is there; none would read as used now — never idle.
      lastUsedAt: used[0]?.at ?? new Date(),
      record: previewRecordOf(row.runtime),
      written: written !== null,
    },
    task: {
      status: row.task.status,
      workspaceId: row.task.workspaceId,
      dataClass: row.task.workspace.dataClass,
    },
    site: {
      id: row.site.id,
      stack: row.site.stack,
      url: row.site.url,
      installedReleaseId: row.site.installedReleaseId,
    },
    repo: repository
      ? {
          provider: repository.provider,
          owner: repository.owner,
          name: repository.name,
          defaultBranch: repository.defaultBranch,
        }
      : null,
    candidate: candidate
      ? {
          id: candidate.id,
          revision: candidate.revision,
          headSha: candidate.headSha,
          files: files?.success ? files.data : [],
          dbPlan: dbPlan?.success ? dbPlan.data : [],
          invalid: !files?.success || !dbPlan?.success,
        }
      : null,
    hasDatabase: live || dump !== null,
    databaseDump: live ? null : (dump?.path ?? null),
  }
}

/** A pass of the agent holds the dialog: its preview is not rebuilt under it (Р23). */
export const isBusyTask = (status: TaskStatus): boolean =>
  status === 'preparing' || status === 'running'

/** A dialog whose pass is queued or runs: its preview is in use, never stopped as idle. */
export const holdsPreview = (status: TaskStatus): boolean =>
  status === 'queued' || isBusyTask(status)

export type PreviewAction = 'destroy' | 'build' | 'expire' | 'none'

/**
 * A served preview no one used for `idleMs` while its dialog waits (owner's answer of 26.10.2026):
 * it is stopped like one whose time is up — its containers stop, its volumes, seed and secrets
 * stay, so nothing the client can see or release is lost. What the dialog changed is in its
 * candidate (files and the sealed plan of the database, replayed by a rebuild, Р22); content the
 * agent wrote outside a candidate is what a rebuild takes out anyway. A view or the next pass
 * starts it again. Only `ready`: a failed or unavailable preview keeps the words of its state.
 */
export function previewIdle(facts: PreviewFacts, now: Date, idleMs: number | undefined): boolean {
  return (
    idleMs !== undefined &&
    facts.preview.status === 'ready' &&
    !holdsPreview(facts.task.status) &&
    now.getTime() - facts.preview.lastUsedAt.getTime() >= idleMs
  )
}

/**
 * What a preview needs now. `requested` — a job asked for it (a new candidate, a reset, a view of
 * a stopped preview, a new pass of its dialog); without it — the sweep looks at it, and only
 * finishes what was left. `lost` — its containers are gone (a restart of the daemon): its
 * upstream may be another preview's now. A preview that serves is never rebuilt under a pass of
 * its dialog: the agent's own writes are in it, and the end of the pass asks again (Р23).
 * `idleMs` — PREVIEW_IDLE_MINUTES: a served preview unused this long is stopped (`previewIdle`).
 */
export function previewAction(
  facts: PreviewFacts,
  options: { requested: boolean; now: Date; lost?: boolean; idleMs?: number },
): PreviewAction {
  const { preview, task } = facts
  if (preview.status === 'destroyed') return 'none'
  if (terminalTaskStatuses.includes(task.status)) return 'destroy'
  const busy = isBusyTask(task.status)
  const idle = previewIdle(facts, options.now, options.idleMs)
  // Lost and unused: nothing is built for no one — a view or the next pass builds it.
  if (preview.status === 'ready' && options.lost) return idle ? 'expire' : 'build'
  if (busy && preview.status === 'ready') return 'none'
  const expired = preview.expiresAt.getTime() <= options.now.getTime()
  // Never built, or a build whose holder died: the holder of the preview now finishes it.
  if (preview.status === 'pending' || preview.status === 'building') return 'build'
  if (expired && !busy && ['ready', 'failed', 'unavailable'].includes(preview.status))
    return 'expire'
  if (idle) return 'expire'
  if (!options.requested) return 'none'
  if (preview.status === 'unavailable')
    // Without an access to the database nothing changed; the other causes may have.
    return preview.unavailableReason === 'no_database' && !facts.hasDatabase ? 'none' : 'build'
  if (preview.status === 'expired' || preview.status === 'failed') return 'build'
  return previewShowsTarget(facts) ? 'none' : 'build'
}

/**
 * The preview shows the candidate of its dialog (or its base) as built: no rebuild is due. A
 * content write since the build counts as not showing it: after a pass whose writes were
 * excluded (a failed pass, the `ceiling` question) its dialog asks for the same revision again,
 * and only a rebuild takes those writes out of the preview (Р22).
 */
export function previewShowsTarget(facts: PreviewFacts): boolean {
  const { preview, candidate } = facts
  return (
    preview.status === 'ready' &&
    preview.revision === (candidate?.revision ?? 0) &&
    preview.candidateId === (candidate?.id ?? null) &&
    (candidate === null || preview.filesSha === candidate.headSha) &&
    !preview.dirty &&
    !preview.written &&
    preview.record.sync === null
  )
}
