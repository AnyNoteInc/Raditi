import {
  gitConnectionKinds,
  repoActionKinds,
  repoActionStates,
  repoBranchStates,
  repoMirrorStates,
  repoModes,
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
  attachConnected,
  attachLink,
  detachRepo,
  readProjectRepo,
  repositoryBranches,
  retryAttach,
} from '../services/git/repositories.ts'
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
          branch: z.string(),
          state: z.enum(repoBranchStates),
          headSha: sha.nullable(),
          sent: z.boolean(),
          canPush: z.boolean(),
          ciChange: z.enum(['none', 'needed', 'declined', 'foreign']),
          mergeRequest: z
            .strictObject({ number: z.number().int(), state: z.string(), url: z.string() })
            .nullable(),
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
