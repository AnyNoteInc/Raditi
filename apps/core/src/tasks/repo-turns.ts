import { createHash } from 'node:crypto'

import { insertFeedEvent, type PrismaClient } from '@repo/db'
import {
  isDomainError,
  repoChatBranch,
  repoUnreachable,
  type FeedRepoChangesPayload,
  type ObjectStorage,
  type RepoLeftReason,
} from '@repo/domain'

import type { GitJobs } from '../git/git-jobs.ts'
import type { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import type { TurnRepositoryOutcome } from '../turns/turn-attempt.ts'
import { REPO_BUNDLE_TIME } from '../turns/turn-repository.ts'
import type { PassRepository, PassRepositoryRow } from './turn-planner.ts'

// A pass of a chat of a project with a repository (docs/plan/84-projects.md, ПР12, ПР26, ПР35,
// §4.3, steps 3 and 8). Before the turn: the main branch fetched into the mirror, the base chosen
// — the chat's own ref when it published before, else the head of the main branch —, the files
// that look like secrets named and the bundle built. After a completed turn: what it left in the
// chat's branch is told by `feed.repo_changes`, its diff kept in `raditi-artifacts`, and changes
// the checks refused by `feed.repo_left`. Nothing here sends anything to the client's repository:
// that is a button of the client (ПР13, slice 84.19).

/** At most this many files of the change are listed on the card (ПР26: «до 10 файлов»). */
export const REPO_CARD_FILES = 10
/** A diff larger than this is not kept for «Посмотреть изменения» (ПР26). */
export const REPO_DIFF_KEPT_BYTES = 2 * 1024 * 1024

/** The key of the diff of a turn in `raditi-artifacts`. */
export const repoDiffKey = (taskId: string, turn: number): string =>
  `repo-diffs/${taskId.toLowerCase()}/${turn}.diff`

/** One changed file of a unified diff of git: its path and counts (binary — 0 and 0). */
export interface DiffFileStat {
  path: string
  additions: number
  deletions: number
}

/** The files of a patch of `git diff` and their counts, in its order. */
export function diffStat(patch: Uint8Array): DiffFileStat[] {
  const text = Buffer.from(patch).toString('utf8')
  const files: DiffFileStat[] = []
  let current: DiffFileStat | null = null
  let inHunk = false
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      current = { path: match?.[2] ?? line.slice(11), additions: 0, deletions: 0 }
      files.push(current)
      inHunk = false
      continue
    }
    if (!current) continue
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) current.additions += 1
    else if (line.startsWith('-')) current.deletions += 1
  }
  return files
}

export interface RepoTurnPreparerDependencies {
  git: Pick<GitJobs, 'fetchForTurn'>
  workspace: Pick<GitWorkspaceService, 'readChatRef' | 'hiddenFiles' | 'buildBaseBundle'>
}

/** The files a sandbox never gets are found once per commit of a repository: a few are kept. */
const HIDDEN_KEPT = 256

/** §4.3, step 3: the repository of a pass, ready for its plan. */
export class RepoTurnPreparer {
  readonly #deps: RepoTurnPreparerDependencies
  readonly #hidden = new Map<string, readonly string[]>()

  constructor(deps: RepoTurnPreparerDependencies) {
    this.#deps = deps
  }

  /**
   * Fetches, chooses the base and builds the bundle. Throws what the pass tells the client:
   * REPOSITORY_TOO_LARGE, GIT_CONNECTION_REAUTH, or REPO_UNREACHABLE for anything else.
   */
  async prepare(chatId: string, row: PassRepositoryRow): Promise<PassRepository> {
    try {
      const { workspace } = this.#deps
      const { sha: head, label } = await this.#deps.git.fetchForTurn(row.projectRepositoryId)
      const chatRef = await workspace.readChatRef(row.projectRepositoryId, chatId)
      const baseSha = chatRef ?? head
      const hiddenPaths = await this.#hiddenOf(row, baseSha)
      const branch = repoChatBranch(chatId)
      const bundle = await workspace.buildBaseBundle({
        projectRepositoryId: row.projectRepositoryId,
        baseSha,
        branch,
        committedAt: REPO_BUNDLE_TIME,
        hiddenPaths,
      })
      return {
        ...row,
        label,
        baseSha,
        sandboxBaseSha: bundle.sandboxBaseSha,
        branch,
        expectedRef: chatRef,
        bundleSha256: bundle.sha256,
        bundleBytes: bundle.sizeBytes,
        hiddenPaths,
      }
    } catch (error) {
      if (
        isDomainError(error) &&
        ['REPOSITORY_TOO_LARGE', 'REPOSITORY_UNSUPPORTED', 'GIT_CONNECTION_REAUTH'].includes(
          error.code,
        )
      )
        throw error
      throw repoUnreachable()
    }
  }

  /** The files flagged at the connection and those of this commit (ПР35), sorted. */
  async #hiddenOf(row: PassRepositoryRow, sha: string): Promise<readonly string[]> {
    const key = `${row.projectRepositoryId}:${sha}`
    let found = this.#hidden.get(key)
    if (!found) {
      found = await this.#deps.workspace.hiddenFiles(row.projectRepositoryId, sha)
      if (this.#hidden.size >= HIDDEN_KEPT) this.#hidden.delete(this.#hidden.keys().next().value!)
      this.#hidden.set(key, found)
    }
    return [...new Set([...row.secretsFound, ...found])].sort()
  }
}

export interface RepoChangesDependencies {
  db: Pick<PrismaClient, '$transaction' | 'taskEvent' | 'taskTurn'>
  storage: Pick<ObjectStorage, 'put'>
  logger?: { log(message: string): void; warn(message: string): void }
}

/** §4.3, step 8: what a completed turn of a chat with a repository left, told in the chat. */
export class RepoChanges {
  readonly #deps: RepoChangesDependencies

  constructor(deps: RepoChangesDependencies) {
    this.#deps = deps
  }

  /**
   * Once per turn: a second call for the same turn finds its row and does nothing. Never
   * throws — the answer is already in the chat; a lost card is told in the log.
   */
  async apply(
    taskId: string,
    turn: number,
    outcome: TurnRepositoryOutcome,
    branch: string,
  ): Promise<void> {
    const { db, storage, logger } = this.#deps
    try {
      const turnRow = await db.taskTurn.findFirst({
        where: { taskId, turnNo: turn },
        select: { id: true },
      })
      const turnId = turnRow?.id ?? null
      const told = await db.taskEvent.findFirst({
        where: {
          taskId,
          turnId,
          type: { in: ['feed.repo_changes', 'feed.repo_left'] },
        },
        select: { id: true },
      })
      if (told) return
      if (outcome.refusal) {
        const reason: RepoLeftReason = outcome.refusal
        await insertFeedEvent(db, {
          taskId,
          turnId,
          row: { type: 'feed.repo_left', payload: { v: 1, reason } },
        })
        logger?.log(`repo_left task=${taskId} turn=${turn} reason=${reason}`)
        return
      }
      if (outcome.headSha === null) return
      const files = diffStat(outcome.patch)
      const diffSha256 = createHash('sha256').update(outcome.patch).digest('hex')
      if (outcome.patch.byteLength <= REPO_DIFF_KEPT_BYTES)
        await storage.put('artifacts', repoDiffKey(taskId, turn), outcome.patch, {
          contentType: 'text/x-diff',
          sizeBytes: outcome.patch.byteLength,
        })
      const payload: FeedRepoChangesPayload = {
        v: 1,
        branch,
        baseSha: outcome.baseSha,
        headSha: outcome.headSha,
        diffSha256,
        files: files.length,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        list: files.slice(0, REPO_CARD_FILES).map((file) => ({
          path: file.path.slice(0, 4096),
          additions: file.additions,
          deletions: file.deletions,
        })),
        ciTouched: outcome.buildPaths.length > 0,
        pushed: false,
        mergeRequest: null,
      }
      await db.$transaction(async (tx) => {
        if (turnId !== null)
          await tx.taskTurn.update({
            where: { id: turnId },
            data: { baseSha: outcome.baseSha, headSha: outcome.headSha },
          })
        await insertFeedEvent(tx, {
          taskId,
          turnId,
          row: { type: 'feed.repo_changes', payload },
        })
      })
      logger?.log(`repo_changes task=${taskId} turn=${turn} files=${files.length}`)
    } catch (error) {
      const code = isDomainError(error) ? error.code : 'unknown'
      logger?.warn(`repo_changes_failed task=${taskId} turn=${turn} reason=${code}`)
    }
  }
}
