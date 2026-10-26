import type { PrismaClient } from '@repo/db'
import {
  INITIAL_SITE_TAG,
  type ObjectStorage,
  provisioningStageSummarySchema,
  releaseOutcomeOf,
  releaseSteps,
  type ReleaseOutcome,
  type ReleaseStep,
} from '@repo/domain'

import { accessibleSite, siteNotFound } from './site-basics.ts'

// The history of a site for «Изменения», «Запуски» and «База и бэкап» (the design of the site page,
// docs/plan/38-site-page-plan.md): what the platform itself recorded — the first import, the
// releases and the steps their deploys reported, the backups they made, where the files and the
// database are. Nothing of a secret, of a log of a program or of an address of the hosting.

/** How a run ended, or `running`; `refused` — a release stopped before the site changed. */
export type RunState = 'running' | 'installed' | 'rolled_back' | 'failed' | 'refused' | 'unknown'

export type RunKind = 'import' | 'release' | 'undo'

export interface SiteRun {
  /** The release id, or `import` for the first import of the site. */
  id: string
  /** 1 for the first import, then each release in the order it was approved. */
  number: number
  kind: RunKind
  /** The first words of the dialog; null for the import. */
  title: string | null
  taskId: string | null
  state: RunState
  /** The release step in work: one of releaseSteps; null when none. */
  step: ReleaseStep | null
  version: string | null
  startedAt: Date
  finishedAt: Date | null
  /** Who approved the release: the name only. */
  approvedBy: string | null
}

export interface SiteRunStep {
  step: ReleaseStep | 'import'
  state: 'started' | 'succeeded' | 'failed' | 'unknown'
  startedAt: Date
  finishedAt: Date | null
}

export interface SiteRunLine {
  at: Date
  step: ReleaseStep | 'import'
  /** What happened, by code: the web side turns it into words. */
  event: 'started' | 'succeeded' | 'failed' | 'unknown' | 'files'
  /** For `files`: how many files and bytes the import saved. */
  files?: number
  bytes?: number
}

export interface SiteRunDetail extends SiteRun {
  steps: SiteRunStep[]
  lines: SiteRunLine[]
}

export interface SiteVersion {
  /** The release id, or `initial` for the first version of the import. */
  id: string
  kind: 'initial' | 'release' | 'undo'
  version: string
  tag: string
  title: string | null
  taskId: string | null
  /** The run that installed it (its number in «Запуски»). */
  run: number
  approvedBy: string | null
  installedAt: Date
  /** On the site now. */
  current: boolean
  /** The copy made before it was installed; null for the first version. */
  backupAt: Date | null
  /** The version a cancellation («Отменить выпуск») undid; null otherwise. */
  undoes: string | null
  /** Undone later by a cancellation that was installed. */
  undone: boolean
}

export interface SiteBackup {
  /** The release whose deploy made it, or `initial` for the files of the import. */
  id: string
  kind: 'release' | 'initial'
  at: Date
  bytes: number | null
  /** The version that followed it (release) or was saved (initial). */
  version: string
  /**
   * `ready` — the copy is in raditi-backups and its owner may download it; `pending` — core has
   * not made it yet; `none` — not offered: a release backup is sealed with a key web cannot open.
   */
  download: 'ready' | 'pending' | 'none'
}

export interface SiteConnections {
  /** Where the files of the site come from; null for a site without access to its files. */
  source: { kind: 'sftp' | 'ftp' | 'git'; tls: 'verified' | 'unverified' | 'plain' | null } | null
  database: {
    engine: 'postgres' | 'mysql'
    databaseName: string
    tls: 'verified' | 'unverified' | 'plain'
    updatedAt: Date
  } | null
}

const nameOf = (user: { name: string; lastName: string | null } | null) =>
  user ? [user.name, user.lastName].filter(Boolean).join(' ') : null

const isReleaseStep = (step: string | null): step is ReleaseStep =>
  step !== null && (releaseSteps as readonly string[]).includes(step)

const stepStates = ['started', 'succeeded', 'failed', 'unknown'] as const
const stepState = (state: string): SiteRunStep['state'] =>
  (stepStates as readonly string[]).includes(state) ? (state as SiteRunStep['state']) : 'unknown'

function runState(outcome: ReleaseOutcome | null): RunState {
  return outcome ?? 'running'
}

const releaseSelect = {
  id: true,
  kind: true,
  taskId: true,
  version: true,
  tag: true,
  status: true,
  step: true,
  mainPushedAt: true,
  approvedAt: true,
  updatedAt: true,
  undoesReleaseId: true,
  deployAttempt: true,
  backupVerifiedAt: true,
  backupBytes: true,
  approver: { select: { name: true, lastName: true } },
  task: { select: { title: true, deletedAt: true } },
  deployment: { select: { finishedAt: true } },
} as const

/** The dialog of a release, when the cabinet still finds it («Удалить диалог»: no way to it). */
const dialogOf = (release: { taskId: string; task: { deletedAt: Date | null } }) =>
  release.task.deletedAt === null ? release.taskId : null

async function siteRows(db: PrismaClient, userId: string, siteId: string) {
  const site = await db.site.findFirst({
    where: accessibleSite(userId, siteId),
    select: {
      id: true,
      installedReleaseId: true,
      installedVersion: true,
      installedAt: true,
      initialVersion: {
        select: {
          tag: true,
          importedAt: true,
          files: true,
          bytes: true,
          backupObjectKey: true,
          backupBytes: true,
        },
      },
      provisioningStages: {
        where: { stage: 'code_import' },
        select: {
          status: true,
          step: true,
          summary: true,
          startedAt: true,
          finishedAt: true,
          createdAt: true,
        },
        take: 1,
      },
      releases: { orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }], select: releaseSelect },
    },
  })
  if (!site) throw siteNotFound()
  return site
}

type SiteRowsOf = Awaited<ReturnType<typeof siteRows>>
type ReleaseRow = SiteRowsOf['releases'][number]

function importRun(site: SiteRowsOf): SiteRun | null {
  const stage = site.provisioningStages[0]
  if (!stage) return null
  const imported = site.initialVersion?.importedAt ?? null
  const state: RunState = imported ? 'installed' : stage.status === 'failed' ? 'failed' : 'running'
  return {
    id: 'import',
    number: 1,
    kind: 'import',
    title: null,
    taskId: null,
    state,
    step: null,
    version: imported ? INITIAL_SITE_TAG : null,
    startedAt: stage.startedAt ?? stage.createdAt,
    finishedAt: imported ?? stage.finishedAt,
    approvedBy: null,
  }
}

function releaseRun(release: ReleaseRow, number: number): SiteRun {
  const outcome = releaseOutcomeOf(release.status, { mainMoved: release.mainPushedAt !== null })
  return {
    id: release.id,
    number,
    kind: release.kind,
    title: release.task.title,
    taskId: dialogOf(release),
    state: runState(outcome),
    step: outcome === null && isReleaseStep(release.step) ? release.step : null,
    version: release.version,
    startedAt: release.approvedAt,
    finishedAt: outcome === null ? null : (release.deployment?.finishedAt ?? release.updatedAt),
    approvedBy: nameOf(release.approver),
  }
}

/** Every run of the site, the newest first: the first import is № 1. */
function allRuns(site: SiteRowsOf): SiteRun[] {
  const first = importRun(site)
  const offset = first ? 2 : 1
  const runs = site.releases.map((release, index) => releaseRun(release, index + offset))
  return [...(first ? [first] : []), ...runs].reverse()
}

export async function listSiteRuns(
  db: PrismaClient,
  input: { userId: string; siteId: string },
): Promise<SiteRun[]> {
  return allRuns(await siteRows(db, input.userId, input.siteId))
}

/** One run with its steps and the lines of its journal; NOT_FOUND for a run of no such site. */
export async function readSiteRun(
  db: PrismaClient,
  input: { userId: string; siteId: string; runId: string },
): Promise<SiteRunDetail> {
  const site = await siteRows(db, input.userId, input.siteId)
  const run = allRuns(site).find((item) => item.id === input.runId)
  if (!run) throw siteNotFound()
  if (run.kind === 'import') {
    const parsed = provisioningStageSummarySchema.safeParse(site.provisioningStages[0]?.summary)
    const summary = parsed.success ? parsed.data : {}
    const end = run.finishedAt
    const state: SiteRunStep['state'] =
      run.state === 'installed' ? 'succeeded' : run.state === 'failed' ? 'failed' : 'started'
    const lines: SiteRunLine[] = [{ at: run.startedAt, step: 'import', event: 'started' }]
    if (end && run.state === 'installed') {
      lines.push({
        at: end,
        step: 'import',
        event: 'files',
        ...(summary.files === undefined ? {} : { files: summary.files }),
        ...(summary.bytes === undefined ? {} : { bytes: summary.bytes }),
      })
    }
    if (end && state !== 'started') lines.push({ at: end, step: 'import', event: state })
    return {
      ...run,
      steps: [{ step: 'import', state, startedAt: run.startedAt, finishedAt: end }],
      lines,
    }
  }
  const release = site.releases.find((item) => item.id === run.id)
  const reports = await db.releaseStep.findMany({
    where: { releaseId: run.id, ...(release ? { deployAttempt: release.deployAttempt } : {}) },
    orderBy: { id: 'asc' },
    select: { step: true, state: true, createdAt: true },
  })
  const steps: SiteRunStep[] = []
  const lines: SiteRunLine[] = []
  for (const report of reports) {
    if (!isReleaseStep(report.step)) continue
    const state = stepState(report.state)
    lines.push({ at: report.createdAt, step: report.step, event: state })
    const open = steps.findLast((item) => item.step === report.step)
    if (open && open.finishedAt === null) {
      open.state = state
      if (state !== 'started') open.finishedAt = report.createdAt
    } else {
      steps.push({
        step: report.step,
        state,
        startedAt: report.createdAt,
        finishedAt: state === 'started' ? null : report.createdAt,
      })
    }
  }
  return { ...run, steps, lines }
}

/**
 * The versions that were on the site, the newest first: the first one of the import and every
 * release that was installed. What is on the site now is the installed release, or — before the
 * first release — the version of the import.
 */
export async function listSiteVersions(
  db: PrismaClient,
  input: { userId: string; siteId: string },
): Promise<SiteVersion[]> {
  const site = await siteRows(db, input.userId, input.siteId)
  const runs = allRuns(site)
  const runOf = (id: string) => runs.find((run) => run.id === id)
  const versions: SiteVersion[] = []
  const initial = site.initialVersion
  if (initial?.importedAt) {
    versions.push({
      id: 'initial',
      kind: 'initial',
      version: initial.tag,
      tag: initial.tag,
      title: null,
      taskId: null,
      run: runOf('import')?.number ?? 1,
      approvedBy: null,
      installedAt: initial.importedAt,
      current: site.installedReleaseId === null,
      backupAt: null,
      undoes: null,
      undone: false,
    })
  }
  const installed = site.releases.filter((release) => releaseRun(release, 0).state === 'installed')
  for (const release of installed) {
    const run = runOf(release.id)
    versions.push({
      id: release.id,
      kind: release.kind,
      version: release.version,
      tag: release.tag,
      title: release.task.title,
      taskId: dialogOf(release),
      run: run?.number ?? 0,
      approvedBy: nameOf(release.approver),
      installedAt: run?.finishedAt ?? release.updatedAt,
      current: site.installedReleaseId === release.id,
      backupAt: release.backupVerifiedAt,
      undoes: site.releases.find((item) => item.id === release.undoesReleaseId)?.version ?? null,
      undone: installed.some((item) => item.kind === 'undo' && item.undoesReleaseId === release.id),
    })
  }
  return versions.reverse()
}

/** The copies the platform made, the newest first: before each release, and the import's files. */
export async function listSiteBackups(
  db: PrismaClient,
  input: { userId: string; siteId: string },
): Promise<SiteBackup[]> {
  const site = await siteRows(db, input.userId, input.siteId)
  const backups: SiteBackup[] = []
  const initial = site.initialVersion
  if (initial?.importedAt) {
    const ready = initial.backupObjectKey !== null && initial.backupBytes !== null
    backups.push({
      id: 'initial',
      kind: 'initial',
      at: initial.importedAt,
      // The archive once it is there; before, the files it will hold.
      bytes: ready ? Number(initial.backupBytes) : initial.bytes,
      version: initial.tag,
      download: ready ? 'ready' : 'pending',
    })
  }
  for (const release of site.releases) {
    if (release.backupVerifiedAt === null) continue
    backups.push({
      id: release.id,
      kind: 'release',
      at: release.backupVerifiedAt,
      bytes: release.backupBytes === null ? null : Number(release.backupBytes),
      version: release.version,
      download: 'none',
    })
  }
  return backups.sort((a, b) => b.at.getTime() - a.at.getTime())
}

const LATIN: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
}

/** «УКК ЖКХ», `v0.0.0` → `ukk-zhkkh-v0.0.0.tar.gz`: a file name any browser and disk take. */
export function backupFileName(siteName: string, version: string): string {
  const base = [...siteName.toLocaleLowerCase('ru')]
    .map((character) => LATIN[character] ?? character)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  const safeVersion = version.replace(/[^A-Za-z0-9.]+/g, '-')
  return `${base || 'site'}-${safeVersion}.tar.gz`
}

export interface BackupDownload {
  body: AsyncIterable<Uint8Array>
  bytes: number
  fileName: string
}

/**
 * The copy of the import's files of a site the user may open (`backupId` = `initial`), streamed
 * from raditi-backups; null for a site of someone else, a copy that is not there yet and any
 * other id — a release backup is sealed with a key only core opens. The bucket and the key never
 * leave the server.
 */
export async function readSiteBackupDownload(
  db: PrismaClient,
  storage: Pick<ObjectStorage, 'get'>,
  input: { userId: string; siteId: string; backupId: string },
): Promise<BackupDownload | null> {
  if (input.backupId !== 'initial') return null
  const site = await db.site.findFirst({
    where: accessibleSite(input.userId, input.siteId),
    select: {
      name: true,
      initialVersion: { select: { tag: true, backupObjectKey: true, backupBytes: true } },
    },
  })
  const initial = site?.initialVersion
  if (!site || !initial?.backupObjectKey || initial.backupBytes === null) return null
  const body = await storage.get('backups', initial.backupObjectKey)
  if (!body) return null
  return {
    body,
    bytes: Number(initial.backupBytes),
    fileName: backupFileName(site.name, initial.tag),
  }
}

/** Where the files and the database of the site are: kinds and protection, never an address. */
export async function readSiteConnections(
  db: PrismaClient,
  input: { userId: string; siteId: string },
): Promise<SiteConnections> {
  const site = await db.site.findFirst({
    where: accessibleSite(input.userId, input.siteId),
    select: {
      codeSource: { select: { kind: true, tls: true } },
      database: { select: { engine: true, databaseName: true, tls: true, updatedAt: true } },
    },
  })
  if (!site) throw siteNotFound()
  return {
    source: site.codeSource ? { kind: site.codeSource.kind, tls: site.codeSource.tls } : null,
    database: site.database,
  }
}
