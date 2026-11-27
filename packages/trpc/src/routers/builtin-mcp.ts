import { builtinMcpServerSchema, vkLimits } from '@repo/domain'
import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import {
  connectVkCommunity,
  disconnectVkCommunity,
  readBuiltinMcp,
  switchBuiltinMcp,
} from '../services/builtin-mcp.ts'
import { publishVkProposal } from '../services/vk-publish.ts'
import { consentedProcedure, router, type Context } from '../trpc.ts'

// «Настройки → Встроенные MCP» (docs/plan/99-vk-community.md, ВК15): the built-in servers of a
// workspace and the VK communities of «ВКонтакте» (services/builtin-mcp.ts). `workspaceId` absent —
// the user's personal workspace.

const builtinMcpOutput = z.strictObject({
  servers: z.array(
    z.strictObject({
      server: builtinMcpServerSchema,
      title: z.string(),
      summary: z.string(),
      needsKey: z.boolean(),
      enabled: z.boolean(),
      communities: z.array(
        z.strictObject({
          id: z.uuid(),
          name: z.string(),
          url: z.string(),
          closed: z.boolean(),
          refused: z.boolean(),
          notices: z.boolean(),
        }),
      ),
    }),
  ),
  canManage: z.boolean(),
  workspaceId: z.uuid().nullable(),
  communitiesLeft: z.number().int().min(0),
})

const site = { workspaceId: z.uuid().optional() }

const placeOf = (ctx: Context & { user: { id: string } }, workspaceId: string | undefined) => ({
  appEnv: chatContextOf(ctx).appEnv,
  userId: ctx.user.id,
  workspaceId,
})

export const builtinMcpRouter = router({
  list: consentedProcedure
    .input(z.strictObject(site))
    .output(builtinMcpOutput)
    .query(({ ctx, input }) => readBuiltinMcp(ctx.prisma, placeOf(ctx, input.workspaceId))),

  switch: consentedProcedure
    .input(z.strictObject({ ...site, server: builtinMcpServerSchema, enabled: z.boolean() }))
    .output(builtinMcpOutput)
    .mutation(({ ctx, input }) =>
      switchBuiltinMcp(ctx.prisma, {
        ...placeOf(ctx, input.workspaceId),
        server: input.server,
        enabled: input.enabled,
      }),
    ),

  /** The key of a VK community: checked against VK, kept in Vault, never shown again. */
  vkConnect: consentedProcedure
    .input(z.strictObject({ ...site, token: z.string().max(vkLimits.tokenChars * 2) }))
    .output(builtinMcpOutput)
    .mutation(({ ctx, input }) =>
      connectVkCommunity(ctx.prisma, ctx.builtinMcp, {
        ...placeOf(ctx, input.workspaceId),
        token: input.token,
      }),
    ),

  /**
   * «Опубликовать» on a card of VK (plan 99, §3.3): the text of the card, maybe edited. Core
   * publishes it; the card learns the result from the feed (`feed.vk_action`).
   */
  vkPublish: consentedProcedure
    .input(z.strictObject({ reservedId: z.uuid(), text: z.string().max(vkLimits.postChars * 2) }))
    .output(z.strictObject({ actionId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      publishVkProposal(ctx.prisma, ctx.builtinMcp?.confirmMac, {
        userId: ctx.user.id,
        reservedId: input.reservedId,
        text: input.text,
      }),
    ),

  vkDisconnect: consentedProcedure
    .input(z.strictObject({ ...site, communityId: z.uuid() }))
    .output(builtinMcpOutput)
    .mutation(({ ctx, input }) =>
      disconnectVkCommunity(ctx.prisma, ctx.builtinMcp, {
        ...placeOf(ctx, input.workspaceId),
        communityId: input.communityId,
      }),
    ),
})
