import { clientIp } from '@repo/auth'
import { agentSkillLimits } from '@repo/domain'
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
    }),
  ),
  canManage: z.boolean(),
  addable: z.number().int().min(0),
})

const site = { siteId: z.uuid() }
const name = z.string().max(agentSkillLimits.nameChars * 2)

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
    .input(z.strictObject({ ...site, name, url: z.string().max(agentSkillLimits.urlChars * 2) }))
    .output(skillsOutput)
    .mutation(({ ctx, input }) =>
      changeSiteAgentSkills(ctx.prisma, {
        siteId: input.siteId,
        userId: ctx.user.id,
        ip: clientIp(ctx.headers),
        change: { kind: 'add', name: input.name, url: input.url },
      }),
    ),

  remove: consentedProcedure
    .input(z.strictObject({ ...site, name }))
    .output(skillsOutput)
    .mutation(({ ctx, input }) =>
      changeSiteAgentSkills(ctx.prisma, {
        siteId: input.siteId,
        userId: ctx.user.id,
        ip: clientIp(ctx.headers),
        change: { kind: 'remove', name: input.name },
      }),
    ),
})
