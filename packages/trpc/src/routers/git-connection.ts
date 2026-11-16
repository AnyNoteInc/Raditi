import { clientIp } from '@repo/auth'
import { gitConnectionKinds, gitConnectionStates, gitTokenInputSchema } from '@repo/domain'
import { z } from 'zod'

import {
  addTokenConnection,
  gitServicesOf,
  listConnections,
  refreshConnection,
  removeConnection,
} from '../services/git/connections.ts'
import { connectionRepositories } from '../services/git/repositories.ts'
import { consentedProcedure, router } from '../trpc.ts'

// «Подключить репозиторий» (docs/plan/84-projects.md, ПР10, §4.4; slice 84.17; P-git-connect,
// P-git-repo-pick): the git connections of the user — only their own, never another member's.
// gitlab.com signs in by `/api/git/gitlab/start`; an own GitLab server takes an address and a
// token here, which core checks.

const connectionRef = z.uuid().transform((id) => id.toLowerCase())

const connectionItem = z.strictObject({
  id: z.uuid(),
  kind: z.enum(gitConnectionKinds),
  signsIn: z.boolean(),
  host: z.string(),
  login: z.string().nullable(),
  state: z.enum(gitConnectionStates),
  reason: z.string().nullable(),
  checkedAt: z.date().nullable(),
})

const repositoryItem = z.strictObject({
  providerRepoId: z.string(),
  path: z.string(),
  name: z.string(),
  visibility: z.string(),
  defaultBranch: z.string(),
  canPush: z.boolean(),
  syncedAt: z.date(),
})

export const gitConnectionRouter = router({
  list: consentedProcedure
    .output(
      z.strictObject({
        connections: z.array(connectionItem),
        available: z.strictObject({
          github: z.boolean(),
          gitlabCom: z.boolean(),
          ownServer: z.boolean(),
        }),
      }),
    )
    .query(({ ctx }) =>
      listConnections(ctx.prisma, ctx.git, {
        userId: ctx.user.id,
        appEnv: ctx.git?.appEnv ?? 'production',
      }),
    ),

  /** «Свой сервер GitLab»: the address is checked to be public (§4.6), core checks the token. */
  addToken: consentedProcedure
    .input(z.strictObject({ host: z.string().min(1).max(300), token: gitTokenInputSchema }))
    .output(z.strictObject({ connectionId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      addTokenConnection(ctx.prisma, gitServicesOf(ctx.git), {
        userId: ctx.user.id,
        host: input.host,
        token: input.token,
        ip: clientIp(ctx.headers),
      }),
    ),

  /** The repositories the connection sees, as core listed them. */
  repositories: consentedProcedure
    .input(z.strictObject({ connectionId: connectionRef, query: z.string().max(100).optional() }))
    .output(
      z.strictObject({
        state: z.enum(['syncing', 'ready', 'failed']),
        reason: z.string().nullable(),
        items: z.array(repositoryItem),
      }),
    )
    .query(async ({ ctx, input }) => {
      const answer = await connectionRepositories(ctx.prisma, {
        userId: ctx.user.id,
        connectionId: input.connectionId,
        ...(input.query === undefined ? {} : { query: input.query }),
      })
      return { state: answer.state, reason: answer.reason, items: [...answer.items] }
    }),

  refresh: consentedProcedure
    .input(z.strictObject({ connectionId: connectionRef }))
    .output(z.strictObject({ queued: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await refreshConnection(ctx.prisma, { userId: ctx.user.id, connectionId: input.connectionId })
      return { queued: true as const }
    }),

  remove: consentedProcedure
    .input(z.strictObject({ connectionId: connectionRef }))
    .output(z.strictObject({ removed: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await removeConnection(ctx.prisma, gitServicesOf(ctx.git), {
        userId: ctx.user.id,
        connectionId: input.connectionId,
        ip: clientIp(ctx.headers),
      })
      return { removed: true as const }
    }),
})
