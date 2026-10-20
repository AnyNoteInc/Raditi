import type { RepoRef } from '@repo/domain'

import type {
  ChangeDigest,
  GitWorkspaceService,
  TrustedCommitInput,
  TrustedCommitPush,
} from './git-workspace.service.ts'

/**
 * Git of a release (docs/plan/53-chat-preview-release.md, Р26, Р27, Р30): what the release skill
 * of core does with the site's repository, over the trusted primitives of GitWorkspaceService —
 * its mirror, its hardened git and its short grants. The release commit and the revert commit
 * are commits of the bot with a stored parent, tree and instant, so a retry after a crash
 * builds the same SHA; both reach `main` by CAS only. Tags are not git's here: the release
 * account makes them through the provider's API (GitProvider.createTag, R8a).
 */
export type ReleaseGit = Pick<
  GitWorkspaceService,
  'readBranchHead' | 'treeOf' | 'treeWith' | 'trustedCommit' | 'pushTrustedCommit' | 'changeDigests'
>

export type { ChangeDigest, TrustedCommitInput, TrustedCommitPush }

/** What a release commit is made of; every field is stored in its `site_releases` row. */
export interface ReleaseCommitFacts {
  releaseId: string
  taskId: string
  candidateId: string
  candidateRevision: number
  version: string
  /** The candidate's head: its tree is the tree of the release. */
  headSha: string
  /** `main` when the release was found ready: the only parent. */
  mainBeforeSha: string
  /** The moment of the confirmation: the instant of the commit. */
  committedAt: Date
}

/**
 * The release commit (Р27): the tree of the candidate on top of `main` as it was found, by the
 * bot at the moment of the confirmation, with the version in its message.
 */
export function releaseCommit(repo: RepoRef, facts: ReleaseCommitFacts): TrustedCommitInput {
  return {
    repo,
    treeOf: facts.headSha,
    parent: facts.mainBeforeSha,
    message:
      `Raditi release ${facts.version}\n\n` +
      `Raditi-Release: ${facts.releaseId}\n` +
      `Raditi-Task: ${facts.taskId}\n` +
      `Raditi-Candidate: ${facts.candidateId}\n` +
      `Raditi-Revision: ${facts.candidateRevision}\n`,
    committedAt: facts.committedAt.toISOString(),
  }
}

/** What a revert commit is made of. */
export interface RevertCommitFacts {
  releaseId: string
  version: string
  /** The release commit on `main`: the only parent. */
  approvedSha: string
  /** What the hosting holds: the tree `main` goes back to. */
  installedSha: string
  committedAt: Date
}

/**
 * The revert commit (Р27): after any end of a release but `installed`, `main` goes back to the
 * tree of the installed version, on top of the release commit — `main` always equals what the
 * hosting holds. Made at the instant of the release commit, so a retry is the same SHA.
 */
export function revertCommit(repo: RepoRef, facts: RevertCommitFacts): TrustedCommitInput {
  return {
    repo,
    treeOf: facts.installedSha,
    parent: facts.approvedSha,
    message:
      `Raditi revert of ${facts.version}\n\n` +
      `Raditi-Release: ${facts.releaseId}\n` +
      `Raditi-Reverts: ${facts.approvedSha}\n`,
    committedAt: facts.committedAt.toISOString(),
  }
}

/** What the commit of an undo is made of (docs/plan/53, «Отмена выпуска»). */
export interface UndoCommitFacts {
  /** The row of the undo. */
  undoId: string
  /** The release it undoes: its version and its commit. */
  undoneVersion: string
  undoneSha: string
  /** The undo's own version. */
  version: string
  /** What the hosting held before the release: the tree the undo goes back to. */
  returnsToSha: string
  /** Media the release added: they stay (`addOnlyPaths` only grow). */
  keep: readonly string[]
  /** `main` when the undo was found ready: the only parent. */
  mainBeforeSha: string
  /** The moment of the confirmation: the instant of the commit. */
  committedAt: Date
}

/**
 * The undo commit: the tree of the version before the release, with the media the release added
 * taken from its commit, on top of `main` as it was found, by the bot at the moment of the
 * confirmation. A new commit, not a `git revert`: a retry builds the same SHA, and the tag of the
 * release undone never moves.
 */
export function undoCommit(repo: RepoRef, facts: UndoCommitFacts): TrustedCommitInput {
  return {
    repo,
    treeOf: facts.returnsToSha,
    ...(facts.keep.length > 0
      ? { overlay: { from: facts.undoneSha, paths: [...facts.keep].sort() } }
      : {}),
    parent: facts.mainBeforeSha,
    message:
      `Raditi undo of ${facts.undoneVersion} as ${facts.version}\n\n` +
      `Raditi-Release: ${facts.undoId}\n` +
      `Raditi-Undoes: ${facts.undoneSha}\n` +
      `Raditi-Returns-To: ${facts.returnsToSha}\n`,
    committedAt: facts.committedAt.toISOString(),
  }
}
