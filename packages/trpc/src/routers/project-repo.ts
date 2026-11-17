import {
  ciRefusals,
  ciStatuses,
  checksStates,
  gitConnectionKinds,
  pullRequestStates,
  repoActionKinds,
  repoActionStates,
  repoBranchStates,
  repoMirrorStates,
  repoModes,
  repoMergeModes,
  repoProviderKinds,
} from '@repo/domain'
import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import {
  confirmCiChange,
  confirmPush,
  declineCiChange,
  prepareCiChange,
  preparePush,
  readChatBranch,
  readTurnDiff,
} from '../services/git/branches.ts'
import { gitServicesOf } from '../services/git/connections.ts'
import {
  confirmDeploy,
  confirmMerge,
  prepareDeploy,
  prepareMerge,
  readRepoAction,
} from '../services/git/merge.ts'
import {
  attachConnected,
  attachLink,
  detachRepo,
  readProjectRepo,
  repositoryBranches,
  retryAttach,
} from '../services/git/repositories.ts'
import {
  confirmRevert,
  confirmRunAction,
  prepareRevert,
  prepareRunAction,
  readRepoPaths,
} from '../services/git/run-actions.ts'
import { readJobLog, readRepoWork, readRun, readRuns } from '../services/git/runs.ts'
import { consentedProcedure, router } from '../trpc.ts'

// The repository of a project (docs/plan/84-projects.md, ПР9, ПР10, §4.4; slice 84.17): attached
// by an open link or by a connection of the author, one per project. Core reads it after the
// answer; `get` says how far it got.

const projectRef = z.uuid().transform((id) => id.toLowerCase())

export const projectRepoView = z.strictObject({
  id: z.uuid(),
  provider: z.enum(repoProviderKinds),
  host: z.string(),
  path: z.string(),
  webUrl: z.string(),
  defaultBranch: z.string(),
  mode: z.enum(repoModes),
  mirrorState: z.enum(repoMirrorStates),
  connection: z
    .strictObject({
      id: z.uuid(),
      kind: z.enum(gitConnectionKinds),
      login: z.string(),
      state: z.string(),
    })
    .nullable(),
  refusal: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
  secretsFound: z.array(z.string()),
  fetchedAt: z.date().nullable(),
})

const sha = z.string().regex(/^[0-9a-f]{40}$/)
const fileStat = z.strictObject({
  path: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
})
const mergeRequestInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(4000),
  draft: z.boolean(),
  reservedId: z.uuid().nullable(),
})

const runId = z.string().regex(/^[1-9][0-9]{0,39}$/)
const chatRef = z.strictObject({ id: z.uuid(), title: z.string().nullable() }).nullable()
const runView = z.strictObject({
  id: runId,
  name: z.string(),
  ref: z.string(),
  sha,
  event: z.string().nullable(),
  status: z.enum(ciStatuses),
  refusal: z.enum(ciRefusals).nullable(),
  url: z.string(),
  createdAt: z.date(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  chat: chatRef,
  stages: z.array(z.string()),
})
const jobView = z.strictObject({
  id: runId,
  name: z.string(),
  stage: z.string().nullable(),
  status: z.enum(ciStatuses),
  manual: z.boolean(),
  refusal: z.enum(ciRefusals).nullable(),
  url: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})

export const projectRepoRouter = router({
  /**
   * By a connection (`connectionId`, `providerRepoId`, `defaultBranch`) or by an open link
   * (`publicUrl`). A link to a private repository is said by `get` (REPO_LINK_PRIVATE) once core
   * has asked the provider.
   */
  attach: consentedProcedure
    .input(
      z.union([
        z.strictObject({
          projectId: projectRef,
          connectionId: z.uuid(),
          providerRepoId: z.string().regex(/^[1-9][0-9]{0,39}$/),
          defaultBranch: z.string().min(1).max(255),
        }),
        z.strictObject({ projectId: projectRef, publicUrl: z.string().min(1).max(500) }),
      ]),
    )
    .output(z.strictObject({ projectRepositoryId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      'publicUrl' in input
        ? attachLink(ctx.prisma, gitServicesOf(ctx.git), {
            userId: ctx.user.id,
            projectId: input.projectId,
            publicUrl: input.publicUrl,
          })
        : attachConnected(ctx.prisma, {
            userId: ctx.user.id,
            projectId: input.projectId,
            connectionId: input.connectionId.toLowerCase(),
            providerRepoId: input.providerRepoId,
            defaultBranch: input.defaultBranch,
          }),
    ),

  /** «Отключить репозиторий»: TASK_PROJECT_BUSY while a chat of the project is at work (ПР32). */
  detach: consentedProcedure
    .input(z.strictObject({ projectId: projectRef }))
    .output(z.strictObject({ detached: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await detachRepo(ctx.prisma, { userId: ctx.user.id, projectId: input.projectId })
      return { detached: true as const }
    }),

  /** «Обновить» of a repository core could not read. */
  retry: consentedProcedure
    .input(z.strictObject({ projectId: projectRef }))
    .output(z.strictObject({ queued: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await retryAttach(ctx.prisma, { userId: ctx.user.id, projectId: input.projectId })
      return { queued: true as const }
    }),

  get: consentedProcedure
    .input(z.strictObject({ projectId: projectRef }))
    .output(projectRepoView.nullable())
    .query(({ ctx, input }) =>
      readProjectRepo(ctx.prisma, { userId: ctx.user.id, projectId: input.projectId }),
    ),

  /**
   * The chat's branch for the card «Изменения в ветке» (ПР13, ПР26): its head, whether it waits to
   * be sent, its merge request and the last press; null — the chat has no change in a repository.
   */
  branch: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(
      z
        .strictObject({
          projectId: z.uuid(),
          branch: z.string(),
          state: z.enum(repoBranchStates),
          headSha: sha.nullable(),
          sent: z.boolean(),
          canPush: z.boolean(),
          pushBlocked: z.enum(['reauth', 'other_member']).nullable(),
          ciChange: z.enum(['none', 'needed', 'declined', 'foreign']),
          mergeRequest: z
            .strictObject({
              number: z.number().int(),
              state: z.string(),
              checks: z.string(),
              url: z.string(),
              headSha: sha,
              autoMerge: z.boolean(),
            })
            .nullable(),
          lastRun: z
            .strictObject({
              id: runId,
              status: z.enum(ciStatuses),
              refusal: z.enum(ciRefusals).nullable(),
              url: z.string(),
            })
            .nullable(),
          rewinds: z.boolean(),
          lastAction: z
            .strictObject({
              id: z.uuid(),
              kind: z.enum(repoActionKinds),
              state: z.enum(repoActionStates),
              error: z.string().nullable(),
            })
            .nullable(),
        })
        .nullable(),
    )
    .query(({ ctx, input }) =>
      readChatBranch(ctx.prisma, { userId: ctx.user.id, taskId: input.taskId }),
    ),

  /** «Посмотреть изменения» of a card: the diff of its turn, up to 2 MiB (ПР26). */
  diff: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), headSha: sha }))
    .output(z.strictObject({ patch: z.string().nullable(), truncated: z.boolean() }))
    .query(({ ctx, input }) => {
      return readTurnDiff(ctx.prisma, chatContextOf(ctx).storage(), {
        userId: ctx.user.id,
        taskId: input.taskId,
        headSha: input.headSha,
      })
    }),

  /**
   * «Отправить в ветку» / «Открыть запрос на слияние», the first step (ПР13): what goes and the
   * token bound to the head of the chat and the diff of its card, for ten minutes.
   */
  preparePush: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(
      z.strictObject({
        branch: z.string(),
        headSha: sha,
        diffSha256: z.string().nullable(),
        stat: z.strictObject({
          files: z.number().int(),
          additions: z.number().int(),
          deletions: z.number().int(),
          list: z.array(fileStat),
        }),
        rewinds: z.boolean(),
        opensMergeRequest: z.boolean(),
        proposal: mergeRequestInput.nullable(),
        confirmToken: z.string(),
        expiresAt: z.date(),
      }),
    )
    .mutation(({ ctx, input }) =>
      preparePush(ctx.prisma, ctx.git?.confirmMac, {
        userId: ctx.user.id,
        taskId: input.taskId,
        now: new Date(),
      }),
    ),

  /** The press itself (ПР13, ПР15): written once, and core sends the branch. */
  confirmPush: consentedProcedure
    .input(
      z.strictObject({
        confirmToken: z.string().min(1).max(2048),
        mergeRequest: mergeRequestInput.optional(),
      }),
    )
    .output(z.strictObject({ actionId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      confirmPush(ctx.prisma, ctx.git?.confirmMac, {
        userId: ctx.user.id,
        confirmToken: input.confirmToken,
        ...(input.mergeRequest ? { mergeRequest: input.mergeRequest } : {}),
        now: new Date(),
      }),
    ),

  /**
   * The card «Агент хочет изменить настройки сборки» (ПР16): the diff of the build settings and CI
   * Lint as core kept them, and the token of that very diff; `loading` until core has read them.
   */
  prepareCiChange: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(
      z.discriminatedUnion('state', [
        z.strictObject({ state: z.literal('loading') }),
        z.strictObject({
          state: z.literal('ready'),
          branch: z.string(),
          headSha: sha,
          files: z.array(fileStat.extend({ diff: z.string() })),
          ciDiffSha256: z.string().nullable(),
          lint: z.strictObject({ valid: z.boolean(), errors: z.array(z.string()) }).nullable(),
          opensMergeRequest: z.boolean(),
          proposal: mergeRequestInput.nullable(),
          confirmToken: z.string(),
          expiresAt: z.date(),
        }),
      ]),
    )
    .mutation(({ ctx, input }) =>
      prepareCiChange(ctx.prisma, chatContextOf(ctx).storage(), ctx.git?.confirmMac, {
        userId: ctx.user.id,
        taskId: input.taskId,
        now: new Date(),
      }),
    ),

  /** «Разрешить и отправить» (ПР16): written once, and core sends the branch. */
  confirmCiChange: consentedProcedure
    .input(
      z.strictObject({
        confirmToken: z.string().min(1).max(2048),
        mergeRequest: mergeRequestInput.optional(),
      }),
    )
    .output(z.strictObject({ actionId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      confirmCiChange(ctx.prisma, ctx.git?.confirmMac, {
        userId: ctx.user.id,
        confirmToken: input.confirmToken,
        ...(input.mergeRequest ? { mergeRequest: input.mergeRequest } : {}),
        now: new Date(),
      }),
    ),

  /** «Не отправлять» (ПР16): this change of build settings is not sent. */
  declineCiChange: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(z.strictObject({ declined: z.literal(true) }))
    .mutation(({ ctx, input }) =>
      declineCiChange(ctx.prisma, { userId: ctx.user.id, taskId: input.taskId }),
    ),

  /**
   * The card «Принять запрос в основную ветку?» (ПР15; slice 84.22): the merge request as core last
   * read it and the token bound to it, its target branch and its head, for ten minutes.
   */
  prepareMerge: consentedProcedure
    .input(z.strictObject({ projectId: projectRef, number: z.number().int().positive() }))
    .output(
      z.strictObject({
        number: z.number().int(),
        title: z.string(),
        source: z.string(),
        target: z.string(),
        headSha: sha,
        checks: z.enum(checksStates),
        url: z.string(),
        deleteBranch: z.boolean(),
        whenGreen: z.boolean(),
        confirmToken: z.string(),
        expiresAt: z.date(),
      }),
    )
    .mutation(({ ctx, input }) =>
      prepareMerge(ctx.prisma, ctx.git?.confirmMac, {
        userId: ctx.user.id,
        projectId: input.projectId,
        number: input.number,
        now: new Date(),
      }),
    ),

  /** «Принять в основную ветку» or «Принять, когда сборка пройдёт»: written once, core merges. */
  confirmMerge: consentedProcedure
    .input(
      z.strictObject({
        confirmToken: z.string().min(1).max(2048),
        mode: z.enum(repoMergeModes),
        deleteBranch: z.boolean(),
      }),
    )
    .output(z.strictObject({ actionId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      confirmMerge(ctx.prisma, ctx.git?.confirmMac, {
        userId: ctx.user.id,
        confirmToken: input.confirmToken,
        mode: input.mode,
        deleteBranch: input.deleteBranch,
        now: new Date(),
      }),
    ),

  /**
   * «Выкатить» on P-repo (ПР15): the manual jobs of the head of the main branch, a token for each;
   * `loading` until core has read the repository.
   */
  prepareDeploy: consentedProcedure
    .input(z.strictObject({ projectId: projectRef }))
    .output(
      z.discriminatedUnion('state', [
        z.strictObject({ state: z.literal('loading') }),
        z.strictObject({
          state: z.literal('ready'),
          ref: z.string(),
          sha: sha.nullable(),
          actions: z.array(
            z.strictObject({
              id: z.string(),
              kind: z.enum(['manual_job', 'workflow_dispatch']),
              name: z.string(),
              confirmToken: z.string(),
            }),
          ),
          expiresAt: z.date(),
        }),
      ]),
    )
    .mutation(({ ctx, input }) =>
      prepareDeploy(ctx.prisma, ctx.git?.confirmMac, {
        userId: ctx.user.id,
        projectId: input.projectId,
        now: new Date(),
      }),
    ),

  /** The press of «Выкатить»: written once, core reads the head again and plays the job. */
  confirmDeploy: consentedProcedure
    .input(z.strictObject({ confirmToken: z.string().min(1).max(2048) }))
    .output(z.strictObject({ actionId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      confirmDeploy(ctx.prisma, ctx.git?.confirmMac, {
        userId: ctx.user.id,
        confirmToken: input.confirmToken,
        now: new Date(),
      }),
    ),

  /**
   * «Запустить снова» or «Остановить» of a build (ПР17; slice 84.26): the build as core last read
   * it and a token bound to it; a rerun of a build of the main branch or one with deploy jobs is a
   * card of a deploy (`deploy`, ПР15).
   */
  prepareRunAction: consentedProcedure
    .input(z.strictObject({ projectId: projectRef, runId, kind: z.enum(['rerun', 'cancel']) }))
    .output(
      z.strictObject({
        kind: z.enum(['rerun', 'cancel']),
        runId,
        name: z.string(),
        ref: z.string(),
        sha,
        status: z.enum(ciStatuses),
        deploy: z.boolean(),
        confirmToken: z.string(),
        expiresAt: z.date(),
      }),
    )
    .mutation(({ ctx, input }) =>
      prepareRunAction(ctx.prisma, ctx.git?.confirmMac, {
        userId: ctx.user.id,
        projectId: input.projectId,
        runId: input.runId,
        kind: input.kind,
        now: new Date(),
      }),
    ),

  /** The press of the card of a build: written once, core reads the build again. */
  confirmRunAction: consentedProcedure
    .input(z.strictObject({ confirmToken: z.string().min(1).max(2048) }))
    .output(z.strictObject({ actionId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      confirmRunAction(ctx.prisma, ctx.git?.confirmMac, {
        userId: ctx.user.id,
        confirmToken: input.confirmToken,
        now: new Date(),
      }),
    ),

  /** «Отменить принятые изменения?» of a merged request (ПР15; slice 84.26). */
  prepareRevert: consentedProcedure
    .input(z.strictObject({ projectId: projectRef, number: z.number().int().positive() }))
    .output(
      z.strictObject({
        number: z.number().int(),
        title: z.string(),
        target: z.string(),
        mergeSha: sha,
        url: z.string(),
        confirmToken: z.string(),
        expiresAt: z.date(),
      }),
    )
    .mutation(({ ctx, input }) =>
      prepareRevert(ctx.prisma, ctx.git?.confirmMac, {
        userId: ctx.user.id,
        projectId: input.projectId,
        number: input.number,
        now: new Date(),
      }),
    ),

  /** The press of «Отменить»: core opens a new merge request that takes the changes out. */
  confirmRevert: consentedProcedure
    .input(z.strictObject({ confirmToken: z.string().min(1).max(2048) }))
    .output(z.strictObject({ actionId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      confirmRevert(ctx.prisma, ctx.git?.confirmMac, {
        userId: ctx.user.id,
        confirmToken: input.confirmToken,
        now: new Date(),
      }),
    ),

  /**
   * The paths of the main branch for `@` in a chat of the project (ПР24; slice 84.26): what core
   * keeps from its mirror; `loading` while core reads them, `none` without a ready repository.
   */
  paths: consentedProcedure
    .input(z.strictObject({ projectId: projectRef }))
    .output(
      z.discriminatedUnion('state', [
        z.strictObject({ state: z.literal('none') }),
        z.strictObject({ state: z.literal('loading') }),
        z.strictObject({
          state: z.literal('ready'),
          sha,
          paths: z.array(z.string()),
          truncated: z.boolean(),
        }),
      ]),
    )
    .query(({ ctx, input }) =>
      readRepoPaths(ctx.prisma, ctx.chat ? chatContextOf(ctx).storage() : null, {
        userId: ctx.user.id,
        projectId: input.projectId,
        now: new Date(),
      }),
    ),

  /** How far core got with a press of the author (P-repo reads it after «Выкатить»). */
  action: consentedProcedure
    .input(z.strictObject({ projectId: projectRef, actionId: z.uuid() }))
    .output(
      z.strictObject({
        id: z.uuid(),
        kind: z.enum(repoActionKinds),
        state: z.enum(repoActionStates),
        error: z.string().nullable(),
      }),
    )
    .query(({ ctx, input }) =>
      readRepoAction(ctx.prisma, {
        userId: ctx.user.id,
        projectId: input.projectId,
        actionId: input.actionId.toLowerCase(),
      }),
    ),

  /**
   * «Сборки (CI/CD)» of P-repo (ПР17; slice 84.21): the runs core polled, newest first; a look asks
   * core to poll again when it has not for a minute (`refreshing`). Web never calls the provider.
   */
  runs: consentedProcedure
    .input(
      z.strictObject({
        projectId: projectRef,
        cursor: z.date().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
    )
    .output(
      z.strictObject({
        items: z.array(runView),
        next: z.date().nullable(),
        polledAt: z.date().nullable(),
        refreshing: z.boolean(),
      }),
    )
    .query(({ ctx, input }) =>
      readRuns(ctx.prisma, {
        userId: ctx.user.id,
        projectId: input.projectId,
        ...(input.cursor ? { before: input.cursor } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
        now: new Date(),
      }),
    ),

  /** A run with its stages and jobs (P-pipeline). */
  run: consentedProcedure
    .input(z.strictObject({ projectId: projectRef, runId }))
    .output(z.strictObject({ run: runView, jobs: z.array(jobView) }))
    .query(({ ctx, input }) =>
      readRun(ctx.prisma, {
        userId: ctx.user.id,
        projectId: input.projectId,
        runId: input.runId,
        now: new Date(),
      }),
    ),

  /**
   * The log of a job (ПР17): the tail core keeps for a day, ANSI taken out, values and keys masked;
   * `loading` while core fetches it — ask again.
   */
  jobLog: consentedProcedure
    .input(z.strictObject({ projectId: projectRef, runId, jobId: runId }))
    .output(
      z.discriminatedUnion('state', [
        z.strictObject({ state: z.literal('loading') }),
        z.strictObject({ state: z.literal('failed') }),
        z.strictObject({
          state: z.literal('ready'),
          text: z.string(),
          truncated: z.boolean(),
          fetchedAt: z.date(),
        }),
      ]),
    )
    .query(({ ctx, input }) =>
      readJobLog(ctx.prisma, {
        userId: ctx.user.id,
        projectId: input.projectId,
        runId: input.runId,
        jobId: input.jobId,
        now: new Date(),
      }),
    ),

  /** «Запросы на слияние» and «Ветки агента» of P-repo. */
  work: consentedProcedure
    .input(z.strictObject({ projectId: projectRef }))
    .output(
      z.strictObject({
        mergeRequests: z.array(
          z.strictObject({
            number: z.number().int(),
            title: z.string(),
            state: z.enum(pullRequestStates),
            checks: z.enum(checksStates),
            sourceBranch: z.string(),
            url: z.string(),
            chat: chatRef,
          }),
        ),
        branches: z.array(
          z.strictObject({
            branch: z.string(),
            state: z.enum(repoBranchStates),
            pushed: z.boolean(),
            chat: z.strictObject({ id: z.uuid(), title: z.string().nullable() }),
            updatedAt: z.date(),
          }),
        ),
      }),
    )
    .query(({ ctx, input }) =>
      readRepoWork(ctx.prisma, { userId: ctx.user.id, projectId: input.projectId }),
    ),

  /** «Основная ветка» of P-git-repo-pick. */
  branches: consentedProcedure
    .input(
      z.strictObject({
        connectionId: z.uuid(),
        providerRepoId: z.string().regex(/^[1-9][0-9]{0,39}$/),
      }),
    )
    .output(z.strictObject({ state: z.enum(['syncing', 'ready']), names: z.array(z.string()) }))
    .query(({ ctx, input }) =>
      repositoryBranches(ctx.prisma, {
        userId: ctx.user.id,
        connectionId: input.connectionId.toLowerCase(),
        providerRepoId: input.providerRepoId,
      }),
    ),
})
