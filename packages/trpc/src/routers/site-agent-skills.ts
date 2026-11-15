import { clientIp } from '@repo/auth'
import {
  agentSkillAuthKinds,
  agentSkillAuthStates,
  agentSkillHeaderLimits,
  agentSkillLimits,
} from '@repo/domain'
import { z } from 'zod'

import { changeSiteAgentSkills, readSiteAgentSkills } from '../services/site-agent-skills.ts'
import { consentedProcedure, router } from '../trpc.ts'

// «Навыки агента» of a site (services/site-agent-skills.ts): every member reads them, an owner
// or an admin changes them. Names and addresses are checked by the domain in the service.

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
  canManage: z.boolean(),
  addable: z.number().int().min(0),
})

const site = { siteId: z.uuid() }
const name = z.string().max(agentSkillLimits.nameChars * 2)
/** The owner's header and its key; the domain checks both in the service. */
const header = z.strictObject({
  headerName: z.string().max(agentSkillHeaderLimits.nameChars * 2),
  value: z.string().max(agentSkillHeaderLimits.valueMaxChars * 2),
})

export const siteAgentSkillsRouter = router({
  list: consentedProcedure
    .input(z.strictObject(site))
    .output(skillsOutput)
    .query(({ ctx, input }) => readSiteAgentSkills(ctx.prisma, { ...input, userId: ctx.user.id })),

  switch: consentedProcedure
    .input(z.strictObject({ ...site, name, enabled: z.boolean() }))
    .output(skillsOutput)
    .mutation(({ ctx, input }) =>
      changeSiteAgentSkills(ctx.prisma, {
        siteId: input.siteId,
        userId: ctx.user.id,
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
      changeSiteAgentSkills(
        ctx.prisma,
        {
          siteId: input.siteId,
          userId: ctx.user.id,
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

  /** A new key of a server with a header: checked against the server, then written over the old. */
  key: consentedProcedure
    .input(z.strictObject({ ...site, name, header }))
    .output(skillsOutput)
    .mutation(({ ctx, input }) =>
      changeSiteAgentSkills(
        ctx.prisma,
        {
          siteId: input.siteId,
          userId: ctx.user.id,
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
      changeSiteAgentSkills(
        ctx.prisma,
        {
          siteId: input.siteId,
          userId: ctx.user.id,
          ip: clientIp(ctx.headers),
          change: { kind: 'remove', name: input.name },
        },
        ctx.mcpServers ?? null,
      ),
    ),
})
