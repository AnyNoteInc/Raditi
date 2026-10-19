import type { PrismaClient } from '@repo/db'
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
  /** The site has an access to its database (Р4). */
  hasDatabase: boolean
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
  const [repository, candidate, database, access, written] = await Promise.all([
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
  ])
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
    hasDatabase: database !== null || access !== null,
  }
}

/** A pass of the agent holds the dialog: its preview is not rebuilt under it (Р23). */
export const isBusyTask = (status: TaskStatus): boolean =>
  status === 'preparing' || status === 'running'

export type PreviewAction = 'destroy' | 'build' | 'expire' | 'none'

/**
 * What a preview needs now. `requested` — a job asked for it (a new candidate, a reset, a view of
 * a stopped preview); without it — the sweep looks at it, and only finishes what was left.
 * `lost` — its containers are gone (a restart of the daemon): its upstream may be another
 * preview's now. A preview that serves is never rebuilt under a pass of its dialog: the agent's
 * own writes are in it, and the end of the pass asks again (Р23).
 */
export function previewAction(
  facts: PreviewFacts,
  options: { requested: boolean; now: Date; lost?: boolean },
): PreviewAction {
  const { preview, task } = facts
  if (preview.status === 'destroyed') return 'none'
  if (terminalTaskStatuses.includes(task.status)) return 'destroy'
  const busy = isBusyTask(task.status)
  if (preview.status === 'ready' && options.lost) return 'build'
  if (busy && preview.status === 'ready') return 'none'
  const expired = preview.expiresAt.getTime() <= options.now.getTime()
  // Never built, or a build whose holder died: the holder of the preview now finishes it.
  if (preview.status === 'pending' || preview.status === 'building') return 'build'
  if (expired && !busy && ['ready', 'failed', 'unavailable'].includes(preview.status))
    return 'expire'
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
