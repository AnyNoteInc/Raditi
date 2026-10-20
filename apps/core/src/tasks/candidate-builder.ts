import { createHash } from 'node:crypto'

import type { CandidateRecordInput, PrismaClient } from '@repo/db'
import {
  buildDbPlanView,
  candidateCounts,
  candidatePatchKey,
  containsEnvValue,
  isCreatedRef,
  mentionsCreatedId,
  recordIdOf,
  candidateVersionFacts,
  canonicalDbPlanJson,
  compactDbPlan,
  dbPlanEntryFromJournal,
  isDomainError,
  isEmptyCandidate,
  proposeVersion,
  versionTagSchema,
  DomainError,
  type CandidateFacts,
  type CandidateFiles,
  type CandidateMedia,
  type DbPlan,
  type DbPlanView,
  type DbPlanViewInput,
  type ObjectStorage,
  type RepoRef,
  type SiteAdapter,
  type SiteStack,
  type TurnResult,
} from '@repo/domain'

import type { DbPlanValueReader } from '@repo/site-content'
import { candidateGitUnavailable, type CandidateGit } from './candidate-git.ts'
import { siteFactsOf } from './pass-facts.ts'

// The candidate of a pass (docs/plan/53-chat-preview-release.md, Р5, Р22, Р26): what the
// dialog would release now — the change of its head against its base in files and media, the
// compacted plan of its database writes in the preview, the facts the version is proposed by.
// The trusted side reads every part of it: git on core's side, the journal of the preview's
// writes, the versions the site had. The agent's words are only its claims of kind and risk.

/** The checks every new revision starts with, `pending` (Р22). */
export const NEW_CANDIDATE_CHECKS = ['php_lint', 'preview_smoke'] as const

/** The content types of media the agent may add (Р12), by extension. */
const mediaTypes: Readonly<Record<string, string>> = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  woff2: 'font/woff2',
})

export const mediaContentType = (path: string): string => {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return mediaTypes[extension] ?? 'application/octet-stream'
}

const underAny = (path: string, directories: readonly string[]) =>
  directories.some((directory) => path.startsWith(directory))

/** The candidate that stands in the dialog now: `current`, or `stale` after a release. */
export interface StandingCandidate {
  id: string
  revision: number
  baseSha: string
  headSha: string
  dbPlanSha256: string
  facts: CandidateFacts
}

export interface CandidateContext {
  taskId: string
  /** The workspace of the site: whose key seals the values of the plan. */
  workspaceId: string
  /** The site the dialog changes, as its adapter takes it (`dbSettings`). */
  site: { id: string; stack: SiteStack; url: string }
  repo: RepoRef
  /** Directories where media is only added (`SiteAdapter.mediaRules().addOnlyPaths`). */
  addOnlyPaths: readonly string[]
  /** The commit the dialog stands on when no candidate does: its first turn's base. */
  base: string
  standing: StandingCandidate | null
  /** `sites.installed_version`. */
  installedVersion: string | null
  /**
   * `sites.installed_sha`, read with the context: a candidate whose base has another tree than
   * this commit is recorded `stale` (recordCandidate).
   */
  installedSha: string | null
  /** Every `site_releases.version` of the site, the burnt ones included. */
  releasedVersions: readonly string[]
  /** The revision a new candidate gets (nextCandidateRevision). */
  revision: number
}

export interface CandidatePass {
  /** The turn the candidate is the head of; after «Обновить», the last turn of the dialog. */
  turnNo: number
  headSha: string
  /** The new base: «Обновить» moves the dialog onto the current `main`. */
  baseSha?: string
  /** The agent's claims of the pass; null — keep those of the standing candidate. */
  claims: Pick<TurnResult, 'change_type' | 'risk'> | null
}

export type CandidateBuild =
  /** The pass added nothing to the standing candidate: its revision stays (Р5). */
  | { kind: 'unchanged' }
  /**
   * Nothing is changed against the base: the dialog has no candidate (Р7). The tree of the base
   * and the hash of the (empty) plan name what a carrier of an «Обновить» records (`carrier`).
   */
  | { kind: 'empty'; baseTree: string; dbPlanSha256: string }
  | { kind: 'candidate'; record: CandidateRecordInput }

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

/**
 * How many changed files of a candidate name the id a record created by its plan has in the
 * preview, as a number of its own — in a path or an added line (M3 of the review of «Операции БД
 * и миграции»): production gives the record another id, so a style `.page-id-…`, a template
 * `page-….php` or a call `get_permalink(…)` would point at nothing there. A release refuses a
 * candidate with any (`candidateFactsSchema.createdIdFiles`).
 */
export function createdIdFiles(patch: Uint8Array, plan: DbPlan): number {
  const ids = plan.flatMap((operation) =>
    operation.kind === 'post_create' && isCreatedRef(operation.objectRef)
      ? [recordIdOf(operation.objectRef)!]
      : [],
  )
  if (ids.length === 0) return 0
  return Buffer.from(patch)
    .toString('utf8')
    .split(/^diff --git /m)
    .slice(1)
    .filter((file) =>
      file
        .split('\n')
        .some(
          (line, at) =>
            (at === 0 || (line.startsWith('+') && !line.startsWith('+++ '))) &&
            mentionsCreatedId(line, ids),
        ),
    ).length
}

/** The task a candidate is read for. */
export interface CandidateTask {
  id: string
  siteId: string
  site: { stack: SiteStack; url: string; installedVersion: string | null }
}

type CandidateDatabase = Pick<
  PrismaClient,
  'previewDbOperation' | 'gitRepository' | 'taskCandidate' | 'taskTurn' | 'siteRelease' | 'site'
>

/**
 * What the description of a plan is built from (docs/plan/53, «Операции БД и миграции»): the
 * values the mcp role sealed, and the values of the client's variables — a card that holds one
 * is shown and kept without its values.
 */
export interface CandidateValues {
  values: DbPlanValueReader
  /**
   * The values of every variable of the site now (`readSiteEnvValuesToRefuse`), and each variable
   * with the version its row named before they were read: the record of the revision drops a
   * description a variable set since was not checked against (`recordCandidate`).
   */
  clientValues(siteId: string): Promise<ClientValues>
}

export interface ClientValues {
  values: string[]
  variables: { name: string; keyVersion: number }[]
}

const valuesUnavailable = () =>
  new DomainError('CANDIDATE_VALUES_UNAVAILABLE', 'The values of the plan could not be read', 503)

export class CandidateBuilder {
  constructor(
    private readonly db: CandidateDatabase,
    private readonly git: CandidateGit,
    private readonly storage: Pick<ObjectStorage, 'put'>,
    private readonly adapter: (stack: SiteStack) => SiteAdapter,
    private readonly values: CandidateValues | null = null,
  ) {}

  /**
   * The facts a candidate of the dialog is built from, read in PostgreSQL: its repository, its
   * media paths, its base — the standing candidate's, the last one's, or its first turn's — and
   * the versions of the site. null — the dialog has no repository or no base yet.
   */
  async context(
    task: CandidateTask,
    standing: StandingCandidate | null,
    revision: number,
  ): Promise<CandidateContext | null> {
    const [repository, latest, first, releases, site] = await Promise.all([
      this.db.gitRepository.findFirst({
        where: { siteId: task.siteId },
        orderBy: { createdAt: 'asc' },
        select: { provider: true, owner: true, name: true },
      }),
      this.db.taskCandidate.findFirst({
        where: { taskId: task.id },
        orderBy: { revision: 'desc' },
        select: { baseSha: true },
      }),
      this.db.taskTurn.findUnique({
        where: { taskId_turnNo: { taskId: task.id, turnNo: 1 } },
        select: { baseSha: true },
      }),
      this.db.siteRelease.findMany({ where: { siteId: task.siteId }, select: { version: true } }),
      this.db.site.findUnique({
        where: { id: task.siteId },
        select: { installedSha: true, workspaceId: true },
      }),
    ])
    const base = standing?.baseSha ?? latest?.baseSha ?? first?.baseSha ?? null
    if (!repository || !base || !site) return null
    let addOnlyPaths: readonly string[] = []
    try {
      addOnlyPaths = this.adapter(task.site.stack).mediaRules(siteFactsOf(task.site)).addOnlyPaths
    } catch (error) {
      // The stack has no media rules yet: nothing is add-only.
      if (!isDomainError(error) || error.code !== 'NOT_IMPLEMENTED') throw error
    }
    return {
      taskId: task.id,
      workspaceId: site.workspaceId,
      site: { id: task.siteId, stack: task.site.stack, url: task.site.url },
      repo: repository,
      addOnlyPaths,
      base,
      standing,
      installedVersion: task.site.installedVersion,
      installedSha: site.installedSha ?? null,
      releasedVersions: releases.map((release) => release.version),
      revision,
    }
  }

  /**
   * The revision an «Обновить» that left nothing to release records when its dialog goes on (a
   * pass of it is in the queue): no change against `main`, no checks, superseded by its caller
   * at once. It keeps what the planner and the store of assignments read the task branch by —
   * the head the platform wrote last and its base `main` (docs/plan/53-chat-preview-release.md,
   * R3).
   */
  carrier(
    context: CandidateContext,
    pass: { turnNo: number; headSha: string; baseSha: string },
    empty: Extract<CandidateBuild, { kind: 'empty' }>,
  ): CandidateRecordInput {
    const facts: CandidateFacts = {
      changeType: 'none',
      risk: 'low',
      ...candidateCounts([], [], []),
      newFunctionality: false,
    }
    const installed = versionTagSchema.safeParse(context.installedVersion)
    const proposal = proposeVersion(
      {
        installed: installed.success ? installed.data : null,
        releases: context.releasedVersions,
        tags: [],
      },
      candidateVersionFacts(facts),
    )
    return {
      taskId: context.taskId,
      revision: context.revision,
      turnNo: pass.turnNo,
      baseSha: pass.baseSha,
      baseTree: empty.baseTree,
      baseVersion: installed.success ? installed.data : null,
      headSha: pass.headSha,
      files: [],
      media: [],
      dbPlan: [],
      dbPlanSha256: empty.dbPlanSha256,
      proposedBump: proposal.bump,
      proposedVersion: proposal.version,
      facts,
      checks: [],
      installed: null,
    }
  }

  /**
   * What the client reads of the plan before `/release` (docs/plan/53, «Операции БД и
   * миграции»): every operation with its values, new and old, from the states the mcp role sealed
   * — never from the preview. A value of a variable of the client keeps its card without values.
   * Values or Vault that do not answer fail the pass, as storage that does not take the diff
   * does: no revision is recorded without the description of its plan.
   */
  async dbView(
    context: CandidateContext,
    plan: DbPlan,
    planSha256: string,
  ): Promise<{ view: DbPlanView; variables: ClientValues['variables'] }> {
    if (!this.values) throw valuesUnavailable()
    const owner = { workspaceId: context.workspaceId, taskId: context.taskId }
    const reader = this.values.values
    const operations: DbPlanViewInput['operations'][number][] = []
    let refused: ClientValues
    try {
      for (const operation of plan) {
        const [before, after] = await Promise.all([
          reader.readState(owner, operation.objectRef, 'before', operation.before),
          reader.readState(owner, operation.objectRef, 'after', operation.after),
        ])
        operations.push({ operation, before: before.state, after: after.state })
      }
      refused = await this.values.clientValues(context.site.id)
    } catch {
      throw valuesUnavailable()
    }
    let settings: ReturnType<SiteAdapter['dbSettings']> = []
    try {
      settings = this.adapter(context.site.stack).dbSettings(siteFactsOf(context.site))
    } catch (error) {
      if (!isDomainError(error) || error.code !== 'NOT_IMPLEMENTED') throw error
    }
    const view = buildDbPlanView({
      planSha256,
      operations,
      settings,
      holdsVariable: (value) => containsEnvValue(value, refused.values),
    })
    return { view, variables: refused.variables }
  }

  /** The compacted plan of the dialog's database writes that were not excluded (Р3, Р22). */
  async dbPlan(taskId: string): Promise<{ plan: DbPlan; sha256: string }> {
    const rows = await this.db.previewDbOperation.findMany({
      where: { taskId, excluded: false },
      orderBy: { id: 'asc' },
    })
    const plan = compactDbPlan(rows.map((row) => dbPlanEntryFromJournal(row)))
    return { plan, sha256: sha256(canonicalDbPlanJson(plan)) }
  }

  /**
   * What the pass leaves: nothing new, nothing at all, or the next revision. Whether anything
   * changed is told by trees and the plan alone (Р5): every publication is a new commit, so the
   * head is never the base, but its tree is the base's when nothing changed. Only a new revision
   * is compared file by file; its diff is written to `raditi-artifacts` before the revision is
   * recorded, and a revision that is never recorded leaves an object a later one of the same
   * number overwrites.
   */
  async build(context: CandidateContext, pass: CandidatePass): Promise<CandidateBuild> {
    const { plan, sha256: planSha } = await this.dbPlan(context.taskId)
    const standing = context.standing
    const base = pass.baseSha ?? standing?.baseSha ?? context.base
    const { repo } = context
    const headTree = await this.git.treeOf({ repo, sha: pass.headSha })
    if (standing && pass.baseSha === undefined && planSha === standing.dbPlanSha256) {
      const standingTree = await this.git.treeOf({ repo, sha: standing.headSha })
      if (standingTree === headTree) return { kind: 'unchanged' }
    }
    const baseTree = await this.git.treeOf({ repo, sha: base })
    if (isEmptyCandidate({ headTree, baseTree, plan }))
      return { kind: 'empty', baseTree, dbPlanSha256: planSha }

    const change = await this.git.compareCommits({
      repo,
      baseSha: base,
      headSha: pass.headSha,
      addOnlyPaths: context.addOnlyPaths,
    })
    // The comparison stands on the same commits the trees were read from.
    if (change.baseTree !== baseTree || change.headTree !== headTree)
      throw candidateGitUnavailable()

    const added = new Map(change.added.map((file) => [file.path, file.bytes]))
    const isMedia = (path: string, kind: string) =>
      kind === 'added' && added.has(path) && underAny(path, context.addOnlyPaths)
    const files: CandidateFiles = change.files
      .filter((file) => !isMedia(file.path, file.change))
      .map((file) => ({
        path: file.path,
        change: file.change,
        sizeBytes: file.change === 'deleted' ? 0 : file.sizeBytes,
        executable: file.change !== 'deleted' && file.executable,
      }))
    const media: CandidateMedia = change.files
      .filter((file) => isMedia(file.path, file.change))
      .map((file) => {
        const bytes = added.get(file.path)!
        return {
          path: file.path,
          contentType: mediaContentType(file.path),
          sizeBytes: bytes.byteLength,
          sha256: sha256(bytes),
        }
      })

    const claims = pass.claims
      ? { changeType: pass.claims.change_type, risk: pass.claims.risk }
      : standing
        ? { changeType: standing.facts.changeType, risk: standing.facts.risk }
        : { changeType: 'none' as const, risk: 'low' as const }
    const counts = candidateCounts(files, media, plan)
    // Whether the pass adds a feature is not known from the agent's result: a new file says it.
    const facts: CandidateFacts = {
      ...claims,
      ...counts,
      createdIdFiles: createdIdFiles(change.patch, plan),
      newFunctionality: false,
    }
    const installed = versionTagSchema.safeParse(context.installedVersion)
    // One rule with web, which offers the numbers again at `/release` (candidateVersionFacts).
    const proposal = proposeVersion(
      {
        installed: installed.success ? installed.data : null,
        releases: context.releasedVersions,
        // The tags of the repository are read by the release itself (R8a); until then the
        // versions the platform recorded are the history.
        tags: [],
      },
      candidateVersionFacts(facts),
    )

    // What the site has installed, as a tree: the record decides `current` or `stale` by it.
    const installedState = context.installedSha
      ? {
          sha: context.installedSha,
          tree: await this.git.treeOf({ repo, sha: context.installedSha }),
        }
      : null
    const described = plan.length > 0 ? await this.dbView(context, plan, planSha) : null
    await this.storage.put(
      'artifacts',
      candidatePatchKey(context.taskId, context.revision),
      change.patch,
      { contentType: 'text/x-diff', sizeBytes: change.patch.byteLength },
    )
    return {
      kind: 'candidate',
      record: {
        taskId: context.taskId,
        revision: context.revision,
        turnNo: pass.turnNo,
        baseSha: base,
        baseTree,
        baseVersion: installed.success ? installed.data : null,
        headSha: pass.headSha,
        files,
        media,
        dbPlan: plan,
        dbPlanSha256: planSha,
        dbView: described?.view ?? null,
        ...(described ? { dbViewVariables: described.variables } : {}),
        proposedBump: proposal.bump,
        proposedVersion: proposal.version,
        facts,
        checks: [...NEW_CANDIDATE_CHECKS],
        installed: installedState,
      },
    }
  }
}
