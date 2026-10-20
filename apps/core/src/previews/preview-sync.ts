import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import type { PrismaClient } from '@repo/db'
import {
  assertCandidateMedia,
  assertCandidatePath,
  candidateRulesOf,
  DomainError,
  isDomainError,
  isTooLarge,
  normalizeRepoPath,
  turnPlanSchema,
  type PreviewRecipe,
  type PreviewRuntime,
  type PublicationSource,
  type SandboxLabels,
  type TurnCredentialSource,
  type TurnExecutor,
} from '@repo/domain'
import { withSyncedPaths } from '@repo/site-content'

import { untrackedFiles, type UntrackedFile } from '../git-workspace/archive.ts'
import { TAR_END, tarFileHeader, tarPadding } from '../git-workspace/tree-tar.ts'
import {
  previewRecordJson,
  updatePreview,
  writePreviewTree,
  type PreviewGit,
} from './preview-builder.ts'
import { isBusyTask, type PreviewFacts } from './preview-facts.ts'
import type { PreviewHold } from './preview-lease.ts'

// The agent's working tree on its preview during a turn (docs/plan/53-chat-preview-release.md,
// Р23): before an action of the agent's browser the mcp role asks core for a sync
// (`preview_sync_requests`), and core takes what the turn changed against the commit its sandbox
// got — without stopping the agent — and writes it over the files of the preview. Untrusted like
// a capture: the archive passes the checks of `untracked.tar.zst`, every path those of a
// candidate (the working set, the protected paths, media only added) — and, as a capture, never
// with the turn's own key or MCP token in a name or a file.

/** The git a sync needs: the tree of the turn's base and, for a working set, its own commit. */
export interface PreviewSyncGit extends PreviewGit {
  sandboxBase?(source: PublicationSource, committedAt: string): Promise<string | null>
}

export interface PreviewSyncDeps {
  db: PrismaClient
  runtime: PreviewRuntime | null
  git: PreviewSyncGit | null
  executor: Pick<TurnExecutor, 'exportWorkingTree'>
  /** The turn's credentials, which no synced file may hold (as capture refuses them). */
  credentials: Pick<TurnCredentialSource, 'recover'>
}

/** Why a sync request was refused (`preview_sync_requests.error_code`). */
export const previewSyncRefusals = [
  /** The preview does not serve: never built, building, stopped or failed. */
  'not_ready',
  /** The request names no open turn of the preview's dialog. */
  'no_turn',
  /** The executor of the turn cannot export its working tree (runner VMs until M10). */
  'not_supported',
  /** A path or a file of the working tree breaks the rules of a candidate. */
  'files_refused',
  /** The working tree exceeds the limits of a capture. */
  'too_large',
  /** Another work held the preview longer than the agent waits. */
  'busy',
  'failed',
] as const
export type PreviewSyncRefusal = (typeof previewSyncRefusals)[number]

export class PreviewSyncRefused extends Error {
  constructor(readonly code: PreviewSyncRefusal) {
    super(`Preview sync refused: ${code}`)
    this.name = 'PreviewSyncRefused'
  }
}

const refused = (code: PreviewSyncRefusal) => new PreviewSyncRefused(code)

/** The code a refused sync keeps: a word of a fixed set, never a message. */
export function previewSyncErrorCode(error: unknown): PreviewSyncRefusal {
  if (error instanceof PreviewSyncRefused) return error.code
  if (isTooLarge(error)) return 'too_large'
  if (isDomainError(error)) {
    if (error.code === 'NOT_SUPPORTED') return 'not_supported'
    if (['PUBLICATION_FORBIDDEN', 'TURN_OUTPUT_REJECTED', 'BAD_REQUEST'].includes(error.code))
      return 'files_refused'
  }
  return 'failed'
}

/** The open turn a request names, as its assignment row holds it. */
async function openTurn(db: PrismaClient, assignmentId: string | null, taskId: string) {
  if (!assignmentId) throw refused('no_turn')
  const row = await db.turnAssignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      taskId: true,
      sessionId: true,
      turnNo: true,
      firstEpoch: true,
      finishedAt: true,
      containerId: true,
      plan: true,
    },
  })
  if (!row || row.taskId !== taskId || row.finishedAt !== null || !row.containerId)
    throw refused('no_turn')
  const plan = turnPlanSchema.safeParse(row.plan)
  if (!plan.success) throw refused('no_turn')
  return {
    id: row.id,
    containerId: row.containerId,
    plan: plan.data,
    credentials: { taskId, sessionId: row.sessionId, turn: row.turnNo, epoch: row.firstEpoch },
  }
}

/** A file or a name of the export holds one of the turn's credentials verbatim. */
export function syncHasCredential(
  files: readonly UntrackedFile[],
  deletes: readonly string[],
  credentials: readonly string[],
): boolean {
  const values = credentials.filter(Boolean).map((value) => Buffer.from(value, 'utf8'))
  if (!values.length) return false
  const holds = (bytes: Uint8Array) => {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return values.some((value) => buffer.includes(value))
  }
  return (
    files.some((file) => holds(Buffer.from(file.path, 'utf8')) || holds(file.bytes)) ||
    deletes.some((path) => holds(Buffer.from(path, 'utf8')))
  )
}

/** The files and the deletions of an export checked as a candidate's change (Р23). */
export function checkSyncChange(input: {
  files: readonly UntrackedFile[]
  deletes: readonly string[]
  source: PublicationSource
  /** Paths the recipe of the stack writes itself: never the agent's. */
  platform: ReadonlySet<string>
  /** Paths an earlier sync of the turn wrote: a new media file of the turn may go again. */
  synced: ReadonlySet<string>
}): void {
  const rules = candidateRulesOf(input.source)
  const addOnly = input.source.addOnlyPaths ?? []
  const own = (path: string) => {
    if (normalizeRepoPath(path) !== path || input.platform.has(path)) throw refused('files_refused')
    assertCandidatePath(path, rules)
  }
  const isAddOnly = (path: string) => addOnly.some((prefix) => path.startsWith(prefix))
  for (const file of input.files) {
    own(file.path)
    assertCandidateMedia(file.path, file.bytes, rules)
    // Media is published with mode 100644 only: what publication refuses is not shown either.
    if (isAddOnly(file.path) && file.mode !== '100644') throw refused('files_refused')
  }
  for (const path of input.deletes) {
    own(path)
    if (isAddOnly(path) && !input.synced.has(path)) throw refused('files_refused')
  }
}

/** A ustar tar of the checked files, as infra/preview/files.mjs writes it. */
async function* tarOf(files: readonly UntrackedFile[]): AsyncIterable<Uint8Array> {
  for (const file of files) {
    yield tarFileHeader(file.path, file.bytes.byteLength, file.mode === '100755')
    yield file.bytes
    yield tarPadding(file.bytes.byteLength)
  }
  yield TAR_END
}

/**
 * Writes the working tree of the turn of `request` over the preview's files and answers its
 * row. Before the first sync of a turn the files are brought to the turn's base — the head the
 * turn started from — so what the export lists against it is all that differs; later syncs of
 * the same turn also take back the paths an earlier one wrote (the agent may have undone them).
 * The preview is `dirty` afterwards: it no longer shows its revision.
 */
export async function syncWorkingTree(
  deps: PreviewSyncDeps,
  hold: PreviewHold,
  facts: PreviewFacts,
  input: { requestId: string; assignmentId: string | null; recipe: PreviewRecipe | null },
): Promise<{ filesDigest: string }> {
  const { preview } = facts
  if (preview.status !== 'ready' || !preview.upstream || !input.recipe) throw refused('not_ready')
  if (!isBusyTask(facts.task.status)) throw refused('no_turn')
  const turn = await openTurn(deps.db, input.assignmentId, preview.taskId)
  const runtime = deps.runtime
  const git = deps.git
  if (!runtime || !git || !facts.repo) throw refused('not_supported')
  if (!deps.executor.exportWorkingTree) throw refused('not_supported')
  const source = turn.plan.workspace
  const signal = hold.signal
  const base = source.expectedBaseSha
  const sandboxBase =
    source.sandboxBaseSha ??
    (source.workingSet ? await git.sandboxBase?.(source, turn.plan.committedAt) : base) ??
    null
  if (!sandboxBase) throw refused('not_supported')
  const repo = { provider: facts.repo.provider, owner: facts.repo.owner, name: facts.repo.name }

  // The files of the preview at the base of this turn, with what earlier syncs of it wrote.
  let synced = preview.record.sync
  if (synced?.assignmentId !== turn.id || synced.paths === null) {
    await writePreviewTree(runtime, git, {
      repo,
      previewId: preview.id,
      from: preview.dirty || synced?.paths === null ? null : (synced?.baseSha ?? preview.filesSha),
      synced: synced?.paths ?? [],
      to: base,
      recipe: input.recipe,
      signal,
    })
    synced = { assignmentId: turn.id, baseSha: base, paths: [] }
    await updatePreview(deps.db, hold, ['ready'], {
      dirty: true,
      runtime: previewRecordJson({ ...preview.record, sync: synced }),
    })
  }
  const knownPaths = synced.paths ?? []

  const labels: SandboxLabels = {
    workspaceId: turn.plan.sandbox.labels.workspaceId,
    siteId: turn.plan.sandbox.labels.siteId,
    taskId: turn.plan.sandbox.labels.taskId,
    sessionId: turn.plan.sandbox.labels.sessionId,
    turn: turn.plan.sandbox.labels.turn,
  }
  const tree = await deps.executor.exportWorkingTree(
    {
      assignmentId: turn.id,
      containerId: turn.containerId,
      labels,
      baseSha: sandboxBase,
      ...(source.addOnlyPaths?.length ? { addOnlyPaths: source.addOnlyPaths } : {}),
      ...(knownPaths.length ? { alsoPaths: knownPaths } : {}),
    },
    signal,
  )
  const files = await untrackedFiles(tree.archive)
  const credentials = await deps.credentials.recover(turn.credentials)
  if (!credentials) throw refused('no_turn')
  if (syncHasCredential(files, tree.deletes, [credentials.llmApiKey, credentials.mcpToken]))
    throw refused('files_refused')
  const platform = new Set(input.recipe.generatedFiles.map((file) => file.path))
  checkSyncChange({
    files,
    deletes: tree.deletes,
    source,
    platform,
    synced: new Set(knownPaths),
  })
  // A media file the agent adds under a name the site has already would replace it: refused,
  // as its publication would be.
  const addOnly = source.addOnlyPaths ?? []
  const fresh = files
    .map((file) => file.path)
    .filter(
      (path) => addOnly.some((prefix) => path.startsWith(prefix)) && !knownPaths.includes(path),
    )
  if (fresh.length) {
    const absent = new Set(await git.missingPaths({ repo, sha: base, paths: fresh }))
    if (fresh.some((path) => !absent.has(path))) throw refused('files_refused')
  }

  await runtime.writeFiles(
    preview.id,
    { archive: tarOf(files), deletes: tree.deletes, replace: false },
    signal,
  )
  const filesDigest = createHash('sha256').update(tree.archive).digest('hex')
  const paths = withSyncedPaths(knownPaths, [...files.map((file) => file.path), ...tree.deletes])
  hold.assert()
  await deps.db.$transaction(
    async (tx) => {
      await updatePreview(tx, hold, ['ready'], {
        dirty: true,
        runtime: previewRecordJson({
          ...preview.record,
          sync: { assignmentId: turn.id, baseSha: base, paths },
        }),
      })
      const { count } = await tx.previewSyncRequest.updateMany({
        where: { id: input.requestId, completedAt: null },
        data: { completedAt: new Date(), filesDigest },
      })
      if (count !== 1) throw new DomainError('CONFLICT', 'The sync request was answered', 409)
    },
    { isolationLevel: 'ReadCommitted' },
  )
  return { filesDigest }
}
