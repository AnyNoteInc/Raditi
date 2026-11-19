import { enqueueOutbox, projectOwnedBy, type PrismaClient } from '@repo/db'
import {
  ciStatusIsActive,
  gitJobNames,
  projectNotFound,
  readRepoConfirmToken,
  repoConfirmInvalid,
  repoNotMerged,
  repoRunGone,
  repoRunNotFound,
  repoTreeFileSchema,
  repoTreeKey,
  rerunIsDeploy,
  rerunPassedIsNewBuild,
  signRepoConfirmToken,
  type CiStatus,
  type ObjectStorage,
  type RepoConfirmMac,
} from '@repo/domain'

import { expiry, macOf, nonce, writableRepository, writePress } from './merge.ts'

// The rest of the second queue in the cabinet (docs/plan/84-projects.md, ПР15, ПР17, ПР24; slice
// 84.26): «Запустить снова» and «Остановить» of a build, «Отменить» of a merged request, and the
// paths of the main branch for `@`. The buttons are trusted cards, as a merge is: `prepare…` binds a
// token to the build or the request as core last read them, `confirm…` writes the press and the job
// `git.action`, and core reads the provider again before it does anything. A rerun of a build of
// the main branch or of one with deploy jobs is a card of a deploy (ПР15): its words say so and
// core reruns it only while its commit is the head of its branch. A rerun of a build of any other
// branch that passed warns (ПР36) that it starts a new build of the branch, which repeats every
// automatic job — a deploy without a manual start included.

export interface PreparedRunAction {
  kind: 'rerun' | 'cancel'
  runId: string
  name: string
  ref: string
  sha: string
  status: CiStatus
  /** The card of a deploy (ПР15): the main branch, deploy jobs or a workflow started by hand. */
  deploy: boolean
  /** The plain card warns (ПР36): a rerun of this passed build is a new build of the branch. */
  repeats: boolean
  confirmToken: string
  expiresAt: Date
}

const hasManualJobs = (jobs: unknown): boolean =>
  Array.isArray(jobs) &&
  jobs.some(
    (job) =>
      typeof job === 'object' && job !== null && (job as { manual?: unknown }).manual === true,
  )

/** `projectRepo.prepareRunAction`: the card «Запустить сборку снова?» or «Остановить сборку?». */
export async function prepareRunAction(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: { userId: string; projectId: string; runId: string; kind: 'rerun' | 'cancel'; now: Date },
): Promise<PreparedRunAction> {
  const sign = macOf(mac)
  const { project, repo } = await writableRepository(db, input.userId, input.projectId)
  const run = await db.projectCiRun.findUnique({
    where: {
      projectRepositoryId_providerRunId: {
        projectRepositoryId: repo.id,
        providerRunId: input.runId,
      },
    },
    select: {
      providerRunId: true,
      name: true,
      ref: true,
      sha: true,
      status: true,
      event: true,
      jobs: true,
    },
  })
  if (run === null) throw repoRunNotFound()
  const status = run.status as CiStatus
  // A rerun of what still goes and a cancel of what ended act on nothing.
  if (ciStatusIsActive(status) !== (input.kind === 'cancel')) throw repoRunGone()
  const deploy = rerunIsDeploy({
    ref: run.ref,
    defaultBranch: repo.defaultBranch,
    event: run.event,
    manualJobs: hasManualJobs(run.jobs),
  })
  const repeats = rerunPassedIsNewBuild({
    ref: run.ref,
    defaultBranch: repo.defaultBranch,
    event: run.event,
    manualJobs: hasManualJobs(run.jobs),
    status,
  })
  const expiresAt = expiry(input.now)
  const confirmToken = signRepoConfirmToken(
    {
      kind: input.kind,
      userId: input.userId,
      projectId: project.id,
      projectRepositoryId: repo.id,
      taskId: null,
      number: null,
      targetBranch: run.ref,
      headSha: run.sha,
      diffSha256: null,
      ciDiffSha256: null,
      opensMergeRequest: false,
      deploy: null,
      run: { id: run.providerRunId, ref: run.ref, deploy },
      nonce: nonce(),
      expiresAt,
    },
    sign,
  )
  return {
    kind: input.kind,
    runId: run.providerRunId,
    name: run.name,
    ref: run.ref,
    sha: run.sha,
    status,
    deploy,
    repeats,
    confirmToken,
    expiresAt: new Date(expiresAt * 1000),
  }
}

/** `projectRepo.confirmRunAction`: the press; core reads the build again. */
export async function confirmRunAction(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: { userId: string; confirmToken: string; now: Date },
): Promise<{ actionId: string }> {
  const claims = readRepoConfirmToken(input.confirmToken, macOf(mac), input.now)
  if ((claims.kind !== 'rerun' && claims.kind !== 'cancel') || claims.userId !== input.userId)
    throw repoConfirmInvalid()
  return writePress(db, {
    userId: input.userId,
    confirmToken: input.confirmToken,
    claims,
    kind: claims.kind,
    merge: null,
  })
}

export interface PreparedRevert {
  number: number
  title: string
  target: string
  mergeSha: string
  url: string
  confirmToken: string
  expiresAt: Date
}

/**
 * `projectRepo.prepareRevert` (ПР15): «Отменить принятые изменения?» of a request core read merged
 * into the main branch, bound to its merge commit.
 */
export async function prepareRevert(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: { userId: string; projectId: string; number: number; now: Date },
): Promise<PreparedRevert> {
  const sign = macOf(mac)
  const { project, repo } = await writableRepository(db, input.userId, input.projectId)
  const mr = await db.projectMergeRequest.findUnique({
    where: { projectRepositoryId_number: { projectRepositoryId: repo.id, number: input.number } },
    select: {
      number: true,
      taskId: true,
      title: true,
      targetBranch: true,
      state: true,
      mergeSha: true,
      webUrl: true,
    },
  })
  if (
    mr === null ||
    mr.state !== 'merged' ||
    mr.mergeSha === null ||
    mr.targetBranch !== repo.defaultBranch
  )
    throw repoNotMerged()
  const expiresAt = expiry(input.now)
  const confirmToken = signRepoConfirmToken(
    {
      kind: 'revert',
      userId: input.userId,
      projectId: project.id,
      projectRepositoryId: repo.id,
      taskId: mr.taskId,
      number: mr.number,
      targetBranch: mr.targetBranch,
      headSha: mr.mergeSha,
      diffSha256: null,
      ciDiffSha256: null,
      opensMergeRequest: false,
      deploy: null,
      nonce: nonce(),
      expiresAt,
    },
    sign,
  )
  return {
    number: mr.number,
    title: mr.title,
    target: mr.targetBranch,
    mergeSha: mr.mergeSha,
    url: mr.webUrl,
    confirmToken,
    expiresAt: new Date(expiresAt * 1000),
  }
}

/** `projectRepo.confirmRevert`: the press; core makes the revert and opens its merge request. */
export async function confirmRevert(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: { userId: string; confirmToken: string; now: Date },
): Promise<{ actionId: string }> {
  const claims = readRepoConfirmToken(input.confirmToken, macOf(mac), input.now)
  if (claims.kind !== 'revert' || claims.userId !== input.userId || claims.number === null)
    throw repoConfirmInvalid()
  return writePress(db, {
    userId: input.userId,
    confirmToken: input.confirmToken,
    claims,
    kind: 'revert',
    merge: null,
  })
}

export type RepoPaths =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'ready'; sha: string; paths: string[]; truncated: boolean }

/** A look at `@` asks core for the paths of a new head at most this often. */
const TREE_ASK_MS = 60_000

/**
 * `projectRepo.paths` (ПР24): the paths of the main branch core keeps for `@`, by the head it last
 * fetched — without the files a sandbox holds as a stub (ПР35). A newer head than the kept list —
 * the kept one is answered and core is asked for the new one (`git.repo.tree`); none kept, or one
 * of an earlier version of the list (`repoTreeKey`) — `loading`, and core is asked. `none` — no
 * repository, or not ready.
 *
 * `storage` makes the client of `raditi-artifacts`, and is called only when there is a kept list to
 * read: a project without a repository, or one whose list core has not written yet, makes no S3
 * client at all (the regression of plan 84, §10: a process without S3 logged `[storage] invalid
 * configuration` on every look at `@`).
 */
export async function readRepoPaths(
  db: PrismaClient,
  storage: (() => Pick<ObjectStorage, 'get'>) | null,
  input: { userId: string; projectId: string; now: Date },
): Promise<RepoPaths> {
  if ((await projectOwnedBy(db, input.projectId, input.userId)) === null) throw projectNotFound()
  const repo = await db.projectRepository.findUnique({
    where: { projectId: input.projectId },
    select: { id: true, mirrorState: true, lastFetchedSha: true, treeSha: true },
  })
  if (repo === null || repo.mirrorState !== 'ready' || repo.lastFetchedSha === null)
    return { state: 'none' }
  const stream =
    repo.treeSha === null || storage === null
      ? null
      : await storage().get('artifacts', repoTreeKey(repo.id, repo.treeSha))
  if (repo.treeSha !== repo.lastFetchedSha || stream === null)
    await enqueueOutbox(db, {
      topic: 'git',
      type: gitJobNames.repoTree,
      payload: { projectRepositoryId: repo.id, sha: repo.lastFetchedSha },
      dedupeKey: `git.repo.tree:${repo.id}:${repo.lastFetchedSha}:${Math.floor(input.now.getTime() / TREE_ASK_MS)}`,
    })
  if (stream === null) return { state: 'loading' }
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.byteLength
    // A list of 20 000 paths of up to 4 KiB each at most; anything larger is not core's file.
    if (bytes > 96 * 1024 * 1024) return { state: 'loading' }
    chunks.push(chunk)
  }
  let parsed: ReturnType<typeof repoTreeFileSchema.safeParse>
  try {
    parsed = repoTreeFileSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } catch {
    return { state: 'loading' }
  }
  if (!parsed.success || parsed.data.sha !== repo.treeSha) return { state: 'loading' }
  return {
    state: 'ready',
    sha: parsed.data.sha,
    paths: parsed.data.paths,
    truncated: parsed.data.truncated,
  }
}
