import { Module } from '@nestjs/common'
import {
  admitInWindow,
  chatBranch,
  ciRunsOf,
  requestCiLog,
  reserveRepoProposal,
  type PrismaClient,
} from '@repo/db'
import { REPO_LOGS_PER_TURN, type RepoBranchState } from '@repo/domain'
import { PRISMA } from '@repo/service-runtime'

import { McpRepoController } from './mcp-repo.controller.ts'
import { McpRepoService, type McpRepoStore } from './repo-service.ts'
import { MCP_REPO } from './repo.tokens.ts'

/**
 * The store of the repository: rows of the role's database only. What it says of a merge request
 * is the cache core keeps (`project_merge_requests`), never an answer of the provider.
 */
export function postgresRepoStore(db: PrismaClient, now: () => number = Date.now): McpRepoStore {
  return {
    status: async ({ taskId, projectRepositoryId, projectId }) => {
      const repo = await db.projectRepository.findUnique({
        where: { id: projectRepositoryId },
        select: { projectId: true, provider: true, path: true, defaultBranch: true },
      })
      if (repo === null || repo.projectId !== projectId) return null
      const branch = await chatBranch(db, taskId)
      const own = branch?.projectRepositoryId === projectRepositoryId ? branch : null
      const mr = own
        ? await db.projectMergeRequest.findFirst({
            where: { projectRepositoryId, sourceBranch: own.branch },
            orderBy: { number: 'desc' },
            select: { number: true, state: true, checks: true, webUrl: true },
          })
        : null
      return {
        provider: repo.provider,
        path: repo.path,
        defaultBranch: repo.defaultBranch,
        branch: own?.branch ?? '',
        state: (own?.state ?? 'local') as RepoBranchState,
        mergeRequest: mr
          ? { number: mr.number, state: mr.state, checks: mr.checks, url: mr.webUrl }
          : null,
      }
    },
    reserve: (input) => reserveRepoProposal(db, input),
    runs: async (input) =>
      (await ciRunsOf(db, input)).map((run) => ({
        id: run.id,
        name: run.name,
        ref: run.ref,
        sha: run.sha,
        status: run.status,
        refusal: run.refusal,
        jobs: (run.jobs ?? []).map((job) => ({
          id: job.id,
          name: job.name,
          stage: job.stage,
          status: job.status,
          refusal: job.refusal,
        })),
      })),
    defaultBranch: async ({ projectRepositoryId, projectId }) => {
      const repo = await db.projectRepository.findUnique({
        where: { id: projectRepositoryId },
        select: { projectId: true, defaultBranch: true },
      })
      return repo === null || repo.projectId !== projectId ? null : repo.defaultBranch
    },
    // The job of core that fetches a log is an event of the outbox, as `web_*` asks for a browser.
    log: async (input) => {
      const answer = await requestCiLog(db, { ...input, now: new Date(now()) })
      return answer.state === 'ready'
        ? { state: 'ready', text: answer.text, truncated: answer.truncated }
        : answer
    },
    admitLog: (taskId, turnNo) =>
      admitInWindow(db, {
        key: `repo-logs:${taskId}:${turnNo}`,
        limit: REPO_LOGS_PER_TURN,
        windowMs: 24 * 60 * 60 * 1000,
        now: now(),
      }),
  }
}

/**
 * The repository of a chat's project (docs/plan/84-projects.md, §4.4): no profile and no
 * configuration — every composition has it; a turn is offered it while its plan names a repository.
 */
@Module({
  controllers: [McpRepoController],
  providers: [
    {
      provide: MCP_REPO,
      inject: [PRISMA],
      useFactory: (prisma: PrismaClient) =>
        new McpRepoService({ store: postgresRepoStore(prisma) }),
    },
  ],
})
export class RepoModule {}
