import { accountSkillLimits, skillNameSchema } from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  addSkillMarketplace,
  applyAccountSkillUpdate,
  checkAccountSkillUpdates,
  deleteAccountSkill,
  installSkillFromAddress,
  installSkillFromChatFile,
  installSkillFromMarketplace,
  previewAccountSkillUpdate,
  readAccountSkillText,
  readAccountSkills,
  readSkillMarketplaces,
  removeSkillMarketplace,
  restoreAccountSkill,
  switchAccountSkill,
  type AccountSkillServices,
} from '../services/account-skills.ts'
import { consentedProcedure, router, type Context } from '../trpc.ts'

// «Навыки» (docs/plan/97-skills.md, Нв21): the skills of the user's account — every workspace and
// every chat of theirs gets the enabled ones. Reading needs no network; installing reads public
// repositories through `ctx.skills`, which web composes. An uploaded archive comes through
// `POST /api/skills/upload`, not here: a body of tRPC is 256 KiB at most.

const NOT_CONFIGURED = 'Навыки сейчас недоступны. Попробуйте позже'

/** The sources and the store of skills; SKILLS_NOT_CONFIGURED when web has none. */
export function skillServicesOf(ctx: Context): AccountSkillServices {
  if (!ctx.skills) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: NOT_CONFIGURED })
  return ctx.skills
}

const address = z.string().trim().min(1).max(1024)
const repoPath = z.string().max(512)

const installAnswer = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('installed'),
    skillId: z.uuid(),
    name: z.string(),
    enabled: z.boolean(),
  }),
  z.strictObject({ status: z.literal('exists'), name: z.string() }),
  z.strictObject({
    status: z.literal('choose'),
    commit: z.string(),
    skills: z.array(
      z.strictObject({ path: z.string(), name: z.string(), description: z.string().optional() }),
    ),
  }),
])

const skillView = z.strictObject({
  id: z.uuid().nullable(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  summary: z.string().nullable(),
  source: z.enum(['builtin', 'marketplace', 'git', 'upload', 'created']),
  catalog: z.boolean(),
  enabled: z.boolean(),
  userOnly: z.boolean(),
  license: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  sourceLabel: z.string(),
  commit: z.string().nullable(),
  updateAvailable: z.boolean(),
  files: z.number().int(),
  sizeBytes: z.number().int(),
  installedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  history: z.array(
    z.strictObject({ id: z.uuid(), commit: z.string().nullable(), createdAt: z.string() }),
  ),
})

const marketplaceView = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  repo: z.string(),
  host: z.enum(['github', 'gitlab']),
  url: z.string(),
  platform: z.boolean(),
  plugins: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      repo: z.object({
        host: z.enum(['github', 'gitlab']),
        repo: z.string(),
        ref: z.string().optional(),
        path: z.string(),
      }),
      skills: z
        .array(z.object({ path: z.string(), name: z.string(), description: z.string().optional() }))
        .nullable(),
    }),
  ),
  fetchedAt: z.string().nullable(),
  stale: z.boolean(),
})

export const accountSkillsRouter = router({
  list: consentedProcedure
    .output(
      z.strictObject({
        skills: z.array(skillView),
        limits: z.strictObject({ installed: z.number().int(), enabled: z.number().int() }),
        counts: z.strictObject({ installed: z.number().int(), enabled: z.number().int() }),
      }),
    )
    .query(({ ctx }) => readAccountSkills(ctx.prisma, ctx.user.id)),

  /** The names the chat of the user may call with `/` (Нв18): the enabled skills. */
  slashNames: consentedProcedure
    .output(
      z.array(z.strictObject({ name: z.string(), title: z.string(), description: z.string() })),
    )
    .query(async ({ ctx }) =>
      (await readAccountSkills(ctx.prisma, ctx.user.id)).skills
        .filter((skill) => skill.enabled)
        .map((skill) => ({
          name: skill.name,
          title: skill.title,
          description: skill.summary ?? skill.description,
        })),
    ),

  view: consentedProcedure
    .input(z.strictObject({ skillId: z.uuid() }))
    .output(
      z.strictObject({
        skillMd: z.string(),
        files: z.array(
          z.strictObject({
            path: z.string(),
            sizeBytes: z.number().int(),
            executable: z.boolean(),
          }),
        ),
      }),
    )
    .query(({ ctx, input }) =>
      readAccountSkillText(ctx.prisma, skillServicesOf(ctx), { userId: ctx.user.id, ...input }),
    ),

  switch: consentedProcedure
    .input(
      z.union([
        z.strictObject({ skillId: z.uuid(), enabled: z.boolean() }),
        z.strictObject({ builtin: skillNameSchema, enabled: z.boolean() }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      await switchAccountSkill(ctx.prisma, { userId: ctx.user.id, ...input })
      return { ok: true as const }
    }),

  remove: consentedProcedure
    .input(z.strictObject({ skillId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await deleteAccountSkill(ctx.prisma, skillServicesOf(ctx), {
        userId: ctx.user.id,
        ...input,
      })
      return { ok: true as const }
    }),

  restore: consentedProcedure
    .input(z.strictObject({ skillId: z.uuid(), versionId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await restoreAccountSkill(ctx.prisma, { userId: ctx.user.id, ...input })
      return { ok: true as const }
    }),

  installFromAddress: consentedProcedure
    .input(
      z.strictObject({
        address,
        path: repoPath.optional(),
        replace: z.boolean().optional(),
      }),
    )
    .output(installAnswer)
    .mutation(({ ctx, input }) =>
      installSkillFromAddress(ctx.prisma, skillServicesOf(ctx), { userId: ctx.user.id, ...input }),
    ),

  installFromMarketplace: consentedProcedure
    .input(
      z.strictObject({
        marketplaceId: z.uuid(),
        plugin: z.string().max(128),
        path: repoPath.optional(),
        replace: z.boolean().optional(),
      }),
    )
    .output(installAnswer)
    .mutation(({ ctx, input }) =>
      installSkillFromMarketplace(ctx.prisma, skillServicesOf(ctx), {
        userId: ctx.user.id,
        ...input,
      }),
    ),

  /** «Сохранить как навык» of a `.skill` file of a chat (Нв20). */
  installFromChatFile: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), fileId: z.uuid(), replace: z.boolean().optional() }))
    .output(installAnswer)
    .mutation(({ ctx, input }) =>
      installSkillFromChatFile(ctx.prisma, skillServicesOf(ctx), {
        userId: ctx.user.id,
        ...input,
      }),
    ),

  checkUpdates: consentedProcedure
    .output(z.strictObject({ found: z.number().int() }))
    .mutation(async ({ ctx }) => ({
      found: await checkAccountSkillUpdates(ctx.prisma, skillServicesOf(ctx), ctx.user.id),
    })),

  updatePreview: consentedProcedure
    .input(z.strictObject({ skillId: z.uuid() }))
    .output(
      z.strictObject({
        commit: z.string(),
        skillMd: z.string(),
        added: z.array(z.string()),
        changed: z.array(z.string()),
        removed: z.array(z.string()),
      }),
    )
    .mutation(({ ctx, input }) =>
      previewAccountSkillUpdate(ctx.prisma, skillServicesOf(ctx), {
        userId: ctx.user.id,
        ...input,
      }),
    ),

  update: consentedProcedure
    .input(z.strictObject({ skillId: z.uuid(), commit: z.string().regex(/^[0-9a-f]{40}$/u) }))
    .mutation(async ({ ctx, input }) => {
      await applyAccountSkillUpdate(ctx.prisma, skillServicesOf(ctx), {
        userId: ctx.user.id,
        ...input,
      })
      return { ok: true as const }
    }),

  marketplaces: consentedProcedure
    .output(z.array(marketplaceView))
    .query(({ ctx }) => readSkillMarketplaces(ctx.prisma, skillServicesOf(ctx), ctx.user.id)),

  addMarketplace: consentedProcedure
    .input(z.strictObject({ address }))
    .output(marketplaceView)
    .mutation(({ ctx, input }) =>
      addSkillMarketplace(ctx.prisma, skillServicesOf(ctx), { userId: ctx.user.id, ...input }),
    ),

  removeMarketplace: consentedProcedure
    .input(z.strictObject({ marketplaceId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await removeSkillMarketplace(ctx.prisma, { userId: ctx.user.id, ...input })
      return { ok: true as const }
    }),
})

/** The bounds the page shows, without a request. */
export const accountSkillPageLimits = {
  installed: accountSkillLimits.installed,
  enabled: accountSkillLimits.enabled,
  uploadBytes: accountSkillLimits.uploadBytes,
} as const
