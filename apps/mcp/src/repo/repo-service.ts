import {
  isDomainError,
  repoReadOnly,
  repoRequestMergeArgumentsSchema,
  repoStatusArgumentsSchema,
  type RepoProposalPayload,
} from '@repo/domain'

import type { McpTurnAccess } from '../access/mcp-access.ts'

/**
 * The repository of a chat's project for the agent (docs/plan/84-projects.md, ПР13, ПР14, §4.4):
 * `repo_status` reads what the platform keeps of it — the repository, the chat's branch, whether it
 * was sent and its merge request — from the database, never from the provider: `mcp` holds no
 * token of git (§4.6). `repo_request_merge` only reserves a proposal; core shows it when the pass
 * completed, and the merge request opens by the client's button. Which repository comes from the
 * plan of the admitted turn, never from the arguments.
 */
export interface McpRepoStatus {
  provider: string
  path: string
  defaultBranch: string
  /** The chat's branch: its row once its first change was told, else the plan's. */
  branch: string
  state: 'local' | 'pushed' | 'merged' | 'closed'
  mergeRequest: { number: number; state: string; checks: string; url: string } | null
}

export interface McpRepoStore {
  status(input: {
    taskId: string
    projectRepositoryId: string
    projectId: string
  }): Promise<McpRepoStatus | null>
  reserve(input: {
    workspaceId: string
    taskId: string
    turnNo: number
    proposal: RepoProposalPayload
  }): Promise<{ reservationId: string }>
}

export type McpRepoAnswer =
  { ok: true; value: unknown } | { ok: false; code: string; message: string }

const refusal = (error: unknown): McpRepoAnswer => {
  if (isDomainError(error)) return { ok: false, code: error.code, message: error.message }
  throw error
}
const badRequest = (message: string): McpRepoAnswer => ({ ok: false, code: 'BAD_REQUEST', message })
const gone: McpRepoAnswer = {
  ok: false,
  code: 'REPO_GONE',
  message: 'The repository of this turn is no longer attached to the project',
}

export class McpRepoService {
  readonly #store: McpRepoStore

  constructor(deps: { store: McpRepoStore }) {
    this.#store = deps.store
  }

  async status(access: McpTurnAccess, args: unknown = {}): Promise<McpRepoAnswer> {
    if (!repoStatusArgumentsSchema.safeParse(args ?? {}).success) return badRequest('No arguments')
    const repo = access.repository
    if (!repo) return gone
    try {
      const status = await this.#store.status({
        taskId: access.taskId,
        projectRepositoryId: repo.projectRepositoryId,
        projectId: repo.projectId,
      })
      if (!status) return gone
      return {
        ok: true,
        value: {
          provider: status.provider,
          path: status.path,
          mode: repo.mode,
          defaultBranch: status.defaultBranch,
          branch: status.branch,
          baseSha: repo.baseSha,
          pushed: status.state !== 'local',
          ...(status.mergeRequest ? { mergeRequest: status.mergeRequest } : {}),
        },
      }
    } catch (error) {
      return refusal(error)
    }
  }

  async requestMerge(access: McpTurnAccess, args: unknown): Promise<McpRepoAnswer> {
    const parsed = repoRequestMergeArgumentsSchema.safeParse(args)
    if (!parsed.success) return badRequest('Give a title of 1 to 120 and a description up to 4000')
    const repo = access.repository
    if (!repo) return gone
    try {
      if (repo.mode !== 'write') throw repoReadOnly()
      const { reservationId } = await this.#store.reserve({
        workspaceId: access.workspaceId,
        taskId: access.taskId,
        turnNo: access.turn,
        proposal: {
          title: parsed.data.title,
          description: parsed.data.description,
          draft: parsed.data.draft ?? false,
        },
      })
      return {
        ok: true,
        value: {
          ok: true,
          reservedId: reservationId,
          live: 'the client opens it with a button after this turn',
        },
      }
    } catch (error) {
      return refusal(error)
    }
  }
}
