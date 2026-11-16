import { gitConnectionKinds, repoMirrorStates, repoModes, repoProviderKinds } from '@repo/domain'
import { z } from 'zod'

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
