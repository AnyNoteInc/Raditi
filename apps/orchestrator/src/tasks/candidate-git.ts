import {
  candidateFileChanges,
  DomainError,
  isDomainError,
  notImplemented,
  publicationShaSchema,
  type RepoRef,
} from '@repo/domain'
import { z } from 'zod'

import type {
  CandidateRebase,
  CandidateRebaseInput,
  GitWorkspaceService,
} from '../git-workspace/git-workspace.service.ts'

/**
 * What the candidate of a dialog needs from the site's repository, on the trusted side only
 * (docs/plan/53-chat-preview-release.md, Р5, Р27). `GitWorkspaceService` (R4, its mirror of the
 * repository) implements it; this port is how the dialogs of core use it, so a stand-in can
 * replace git in tests.
 */
export interface CandidateGit {
  /** The commit a branch points at, or null: `GitWorkspaceService.readBranchHead`. */
  readBranchHead(input: { repo: RepoRef; branch: string }): Promise<string | null>
  /** The tree a commit points at: `GitWorkspaceService.treeOf`. */
  treeOf(input: { repo: RepoRef; sha: string }): Promise<string>
  /**
   * Whether `compareCommits` can answer at all. Whether a pass changed anything is told by trees
   * alone (`treeOf`); only a pass that did needs the comparison.
   */
  readonly comparesCommits: boolean
  /**
   * The change of `headSha` against `baseSha`, both commits of `repo`: their trees, the binary
   * patch `git diff --binary --full-index --no-renames base head` (at most
   * `publicationLimits.patchBytes`, PUBLICATION_TOO_LARGE above), each changed path, and the
   * bytes of the files added under `addOnlyPaths` (the media of Р12, each at most 8 MiB) so
   * that the candidate can name their type and SHA-256. Asked of R4: plan 53, «Имена».
   * NOT_IMPLEMENTED while the workspace service has no comparison.
   */
  compareCommits(input: CommitComparisonInput): Promise<CommitComparison>
  /** «Обновить»: `GitWorkspaceService.rebaseCandidate` (R4). */
  rebaseCandidate(
    input: CandidateRebaseInput,
    assertFence?: () => Promise<void>,
  ): Promise<CandidateRebase>
}

export interface CommitComparisonInput {
  repo: RepoRef
  baseSha: string
  headSha: string
  addOnlyPaths: readonly string[]
}

export interface ComparedFile {
  path: string
  change: (typeof candidateFileChanges)[number]
  /** After the change; 0 for a deleted file. */
  sizeBytes: number
  executable: boolean
}

export interface CommitComparison {
  baseTree: string
  headTree: string
  patch: Uint8Array
  files: ComparedFile[]
  /** Added files under the add-only paths, with their content. */
  added: Array<{ path: string; bytes: Uint8Array }>
}

const comparisonSchema = z.object({
  baseTree: publicationShaSchema,
  headTree: publicationShaSchema,
  patch: z.instanceof(Uint8Array),
  files: z.array(
    z.object({
      path: z.string().min(1).max(1024),
      change: z.enum(candidateFileChanges),
      sizeBytes: z.number().int().min(0),
      executable: z.boolean(),
    }),
  ),
  added: z.array(z.object({ path: z.string().min(1).max(1024), bytes: z.instanceof(Uint8Array) })),
})

/** git answered something the candidate cannot be built from: no candidate is made. */
export const candidateGitUnavailable = (): DomainError =>
  new DomainError('GIT_OPERATION_FAILED', 'The repository cannot compare candidate commits', 502)

/** The workspace service of this build has no comparison of commits (R4, plan 53 «Имена»). */
export const isComparisonMissing = (error: unknown): boolean =>
  isDomainError(error) && error.code === 'NOT_IMPLEMENTED'

/**
 * The repository as the workspace service names it, and nothing more: its schemas are strict,
 * and a caller often holds the row of `git_repositories` with its default branch beside the ref
 * (the facts of a pass) — passed whole, every read of the branch was refused as BAD_REQUEST.
 */
const refOf = (repo: RepoRef): RepoRef => ({
  provider: repo.provider,
  owner: repo.owner,
  name: repo.name,
})

/**
 * The port over the workspace service of core. `compareCommits` is checked to exist and its
 * answer to have its shape: a service without it answers NOT_IMPLEMENTED, and a pass that
 * changed something cannot become a candidate (the settlement fails it `unavailable`), while
 * passes that changed nothing settle by their trees.
 */
export function candidateGitOf(
  service: Pick<GitWorkspaceService, 'readBranchHead' | 'rebaseCandidate' | 'treeOf'> & {
    compareCommits?: unknown
  },
): CandidateGit {
  const compare = service.compareCommits
  return {
    readBranchHead: (input) => service.readBranchHead({ ...input, repo: refOf(input.repo) }),
    treeOf: (input) => service.treeOf({ ...input, repo: refOf(input.repo) }),
    rebaseCandidate: (input, assertFence) =>
      service.rebaseCandidate({ ...input, repo: refOf(input.repo) }, assertFence),
    comparesCommits: typeof compare === 'function',
    async compareCommits(input) {
      if (typeof compare !== 'function') throw notImplemented('Comparison of candidate commits')
      const answer: unknown = await (compare as CandidateGit['compareCommits']).call(service, {
        ...input,
        repo: refOf(input.repo),
      })
      const parsed = comparisonSchema.safeParse(answer)
      if (!parsed.success) throw candidateGitUnavailable()
      return parsed.data
    },
  }
}
