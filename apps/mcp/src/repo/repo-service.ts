import {
  isDomainError,
  repoJobLogArgumentsSchema,
  repoLogFailed,
  repoLogLimit,
  repoLogLoading,
  repoReadOnly,
  repoRequestMergeArgumentsSchema,
  repoRunsArgumentsSchema,
  repoStatusArgumentsSchema,
  tailOf,
  type CiRefusal,
  type CiStatus,
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

/** A build as core polled it (ПР17): what `repo_runs` gives the agent. */
export interface McpRepoRun {
  id: string
  name: string
  ref: string
  sha: string
  status: CiStatus
  refusal: CiRefusal | null
  jobs: {
    id: string
    name: string
    stage: string | null
    status: CiStatus
    refusal: CiRefusal | null
  }[]
}

export type McpRepoLog =
  { state: 'loading' } | { state: 'failed' } | { state: 'ready'; text: string; truncated: boolean }

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
  runs(input: { projectRepositoryId: string; ref?: string; limit: number }): Promise<McpRepoRun[]>
  /** The main branch of the turn's repository, or null when it is gone. */
  defaultBranch(input: { projectRepositoryId: string; projectId: string }): Promise<string | null>
  /** The kept log, or `loading` after the job of core is asked for (`requestCiLog`). */
  log(input: { projectRepositoryId: string; runId: string; jobId: string }): Promise<McpRepoLog>
  /** One more log of this turn: false — REPO_LOGS_PER_TURN is reached. */
  admitLog(taskId: string, turnNo: number): Promise<boolean>
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

  /**
   * `repo_runs` (ПР17): the newest builds of the chat's branch, of the main one or of both, as core
   * polled them — from the database, never from the provider.
   */
  async runs(access: McpTurnAccess, args: unknown = {}): Promise<McpRepoAnswer> {
    const parsed = repoRunsArgumentsSchema.safeParse(args ?? {})
    if (!parsed.success) return badRequest("branch is 'chat' or 'default'; limit is 1 to 10")
    const repo = access.repository
    if (!repo) return gone
    try {
      let ref: string | undefined
      if (parsed.data.branch === 'chat') ref = repo.branch
      if (parsed.data.branch === 'default') {
        const main = await this.#store.defaultBranch(repo)
        if (main === null) return gone
        ref = main
      }
      const runs = await this.#store.runs({
        projectRepositoryId: repo.projectRepositoryId,
        limit: parsed.data.limit ?? 5,
        ...(ref === undefined ? {} : { ref }),
      })
      return { ok: true, value: { runs } }
    } catch (error) {
      return refusal(error)
    }
  }

  /**
   * `repo_job_log` (ПР17): the tail of a job's log as core keeps it — ANSI taken out, values and
   * keys masked. `REPO_LOG_LOADING` while core fetches it: the agent calls again. A log given
   * counts against REPO_LOGS_PER_TURN; a refusal of loading does not.
   */
  async jobLog(access: McpTurnAccess, args: unknown): Promise<McpRepoAnswer> {
    const parsed = repoJobLogArgumentsSchema.safeParse(args)
    if (!parsed.success)
      return badRequest('Give runId and jobId of repo_runs; tailBytes 1024 to 32768')
    const repo = access.repository
    if (!repo) return gone
    try {
      const log = await this.#store.log({
        projectRepositoryId: repo.projectRepositoryId,
        runId: parsed.data.runId,
        jobId: parsed.data.jobId,
      })
      if (log.state === 'loading') throw repoLogLoading()
      if (log.state === 'failed') throw repoLogFailed()
      if (!(await this.#store.admitLog(access.taskId, access.turn))) throw repoLogLimit()
      const tail = tailOf(log.text, parsed.data.tailBytes ?? 32768)
      return {
        ok: true,
        value: { ok: true, text: tail.text, truncated: log.truncated || tail.truncated },
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
