import { clientIp } from '@repo/auth'
import {
  agentSkillAuthKinds,
  agentSkillAuthStates,
  agentSkillHeaderLimits,
  agentSkillLimits,
} from '@repo/domain'
import { z } from 'zod'

import { changeAgentSkills, checkSkillSignIn, readAgentSkills } from '../services/agent-skills.ts'
import { chatContextOf } from '../services/chat/context.ts'
import { consentedProcedure, router, type Context } from '../trpc.ts'

// «Настройки → Навыки агента» of a workspace (services/agent-skills.ts; plan 83, БП11): every
// member reads them, an owner or an admin changes them, and every chat of the workspace gets them.
// `workspaceId` absent — the user's personal workspace. Names and addresses are checked by the
// domain in the service.

const skillsOutput = z.strictObject({
  skills: z.array(
    z.strictObject({
      name: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      builtin: z.boolean(),
      url: z.string().nullable(),
      enabled: z.boolean(),
      auth: z.strictObject({
        kind: z.enum(agentSkillAuthKinds),
        headerName: z.string().nullable(),
        state: z.enum(agentSkillAuthStates),
        error: z.string().nullable(),
      }),
    }),
  ),
  workspaceId: z.uuid().nullable(),
  canManage: z.boolean(),
  addable: z.number().int().min(0),
})

const site = { workspaceId: z.uuid().optional() }

/** Who asks, in which workspace. */
const placeOf = (ctx: Context & { user: { id: string } }, workspaceId: string | undefined) => ({
  appEnv: chatContextOf(ctx).appEnv,
  userId: ctx.user.id,
  workspaceId,
})
const name = z.string().max(agentSkillLimits.nameChars * 2)
/** The owner's header and its key; the domain checks both in the service. */
const header = z.strictObject({
  headerName: z.string().max(agentSkillHeaderLimits.nameChars * 2),
  value: z.string().max(agentSkillHeaderLimits.valueMaxChars * 2),
})

export const agentSkillsRouter = router({
  list: consentedProcedure
    .input(z.strictObject(site))
    .output(skillsOutput)
    .query(({ ctx, input }) => readAgentSkills(ctx.prisma, placeOf(ctx, input.workspaceId))),

  switch: consentedProcedure
    .input(z.strictObject({ ...site, name, enabled: z.boolean() }))
    .output(skillsOutput)
    .mutation(({ ctx, input }) =>
      changeAgentSkills(ctx.prisma, {
        ...placeOf(ctx, input.workspaceId),
        ip: clientIp(ctx.headers),
        change: { kind: 'switch', name: input.name, enabled: input.enabled },
      }),
    ),

  add: consentedProcedure
    .input(
      z.strictObject({
        ...site,
        name,
        url: z.string().max(agentSkillLimits.urlChars * 2),
        header: header.optional(),
      }),
    )
    .output(skillsOutput)
    .mutation(({ ctx, input }) =>
      changeAgentSkills(
        ctx.prisma,
        {
          ...placeOf(ctx, input.workspaceId),
          ip: clientIp(ctx.headers),
          change: {
            kind: 'add',
            name: input.name,
            url: input.url,
            ...(input.header ? { header: input.header } : {}),
          },
        },
        ctx.mcpServers ?? null,
      ),
    ),

  /**
   * Whether this workspace may sign in to a server by this name (plan 81, §3.4): web asks it before it
   * starts the sign-in, and connects the server after the owner comes back.
   */
  signInCheck: consentedProcedure
    .input(
      z.strictObject({
        ...site,
        name,
        url: z.string().max(agentSkillLimits.urlChars * 2),
      }),
    )
    .output(z.strictObject({ workspaceId: z.uuid(), name: z.string(), url: z.string() }))
    .query(({ ctx, input }) =>
      checkSkillSignIn(ctx.prisma, {
        ...placeOf(ctx, input.workspaceId),
        name: input.name,
        url: input.url,
      }),
    ),

  /** A new key of a server with a header: checked against the server, then written over the old. */
  key: consentedProcedure
    .input(z.strictObject({ ...site, name, header }))
    .output(skillsOutput)
    .mutation(({ ctx, input }) =>
      changeAgentSkills(
        ctx.prisma,
        {
          ...placeOf(ctx, input.workspaceId),
          ip: clientIp(ctx.headers),
          change: { kind: 'key', name: input.name, header: input.header },
        },
        ctx.mcpServers ?? null,
      ),
    ),

  remove: consentedProcedure
    .input(z.strictObject({ ...site, name }))
    .output(skillsOutput)
    .mutation(({ ctx, input }) =>
      changeAgentSkills(
        ctx.prisma,
        {
          ...placeOf(ctx, input.workspaceId),
          ip: clientIp(ctx.headers),
          change: { kind: 'remove', name: input.name },
        },
        ctx.mcpServers ?? null,
      ),
    ),
})
