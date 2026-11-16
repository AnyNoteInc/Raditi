import {
  conflict,
  DomainError,
  isDomainError,
  isSnapshotCredential,
  type RepoPublication,
  type SnapshotMetadata,
  type TurnBundleSource,
  type TurnPlan,
} from '@repo/domain'

// The repository of a turn on core's side (docs/plan/84-projects.md, ПР12, §4.3): the supervisor
// builds the bundle again from the plan, the turn prepares its publication before its snapshot and
// publishes it after `checkpointed`, recovery finishes it. The git itself is GitWorkspaceService,
// whose commands run in the git worker; this module only names what the turns need of it.

/**
 * The root commit of a sandbox is made at this instant: the same tree gives the same commit, so the
 * bundle of an unchanged base is taken from the cache turn after turn.
 */
export const REPO_BUNDLE_TIME = '2000-01-01T00:00:00.000Z'

/** A candidate the trusted git prepared: committed, checked, not yet in the mirror. */
export interface TurnPublication {
  baseSha: string
  headSha: string
  /** The complete patch of the candidate against `baseSha`: what the snapshot keeps. */
  patch: Uint8Array
  /** Changed paths of the build (CI files, `.gitmodules`): marked for the card of ПР16. */
  buildPaths: string[]
  publish(assertFence: () => Promise<void>): Promise<void>
  dispose(): Promise<void>
}

/** What the turns need of the trusted git (GitWorkspaceService). */
export interface TurnRepositoryWorkspace {
  buildBaseBundle(input: {
    projectRepositoryId: string
    baseSha: string
    branch: string
    committedAt: string
    hiddenPaths?: readonly string[]
  }): Promise<TurnBundleSource>
  preparePublication(
    input: RepoPublication & {
      patch: Uint8Array
      untracked: Uint8Array
      credentials: readonly string[]
      refusedValues?: readonly string[]
      hiddenPaths?: readonly string[]
    },
  ): Promise<TurnPublication>
}

/**
 * A turn with a repository asked of a core whose git is not configured (GIT_MIRROR_DIR): nothing
 * can be bundled, captured or published. The client reads `unavailable`.
 */
export const gitNotConfigured = (): DomainError =>
  new DomainError('GIT_NOT_CONFIGURED', 'Git is not configured for a turn with a repository', 503)

/** The bundle a plan names: the trusted git builds it again, the same bytes or a conflict. */
export async function bundleOfPlan(
  git: TurnRepositoryWorkspace,
  repository: NonNullable<TurnPlan['repository']>,
): Promise<TurnBundleSource> {
  const bundle = await git.buildBaseBundle({
    projectRepositoryId: repository.projectRepositoryId,
    baseSha: repository.baseSha,
    branch: repository.branch,
    committedAt: REPO_BUNDLE_TIME,
    hiddenPaths: repository.hiddenPaths,
  })
  if (
    bundle.baseSha !== repository.baseSha ||
    bundle.sandboxBaseSha !== repository.sandboxBaseSha ||
    bundle.sha256 !== repository.bundleSha256 ||
    bundle.sizeBytes !== repository.bundleBytes
  )
    throw conflict('The base bundle differs from the planned repository')
  return bundle
}

/** The publication of a plan: its commit on the base under the chat's ref of the mirror. */
export function publicationOf(plan: TurnPlan): RepoPublication {
  const repository = plan.repository
  if (!repository) throw conflict('A turn without a repository publishes nothing')
  return {
    projectRepositoryId: repository.projectRepositoryId,
    baseSha: repository.baseSha,
    chatId: plan.context.taskId,
    turn: plan.context.turn,
    createdAt: plan.committedAt,
    expectedRef: repository.expectedRef,
  }
}

/**
 * The `git` of the snapshot of a turn with a repository, as the supervisor checks it before the
 * lease: without `headSha`, which only the candidate gives.
 */
export function plannedSnapshotGit(plan: {
  repository?: TurnPlan['repository']
  committedAt: string
  context: { taskId: string }
}): Omit<NonNullable<SnapshotMetadata['git']>, 'headSha'> | undefined {
  const repository = plan.repository
  if (!repository) return undefined
  return {
    provider: repository.provider,
    branch: repository.branch,
    baseSha: repository.baseSha,
    sandboxBaseSha: repository.sandboxBaseSha,
    publication: { taskId: plan.context.taskId, committedAt: plan.committedAt },
  }
}

/**
 * Why a publication was refused, as the feed names it (`feed.repo_left`, ПР12); null — not a
 * refusal of the changes but a failure of the platform, which fails the turn.
 */
export type PublicationRefusal = 'secret_found' | 'client_value' | 'too_large' | 'failed'

export function publicationRefusalOf(error: unknown): PublicationRefusal | null {
  if (isSnapshotCredential(error)) return 'secret_found'
  if (!isDomainError(error)) return null
  const reason = (error.details as { reason?: unknown } | undefined)?.reason
  switch (error.code) {
    case 'PUBLICATION_SECRET':
      // The value of a variable is told apart by its reason (envValueInChange).
      return reason === 'client_variable' ? 'client_value' : 'secret_found'
    case 'PUBLICATION_TOO_LARGE':
      return 'too_large'
    case 'PUBLICATION_FORBIDDEN':
    case 'TURN_OUTPUT_REJECTED':
      return 'failed'
    default:
      return null
  }
}
