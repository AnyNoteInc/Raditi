import { artifactGalleryFilters, artifactGallerySorts } from '@repo/db'
import {
  artifactBlockKeySchema,
  artifactKinds,
  artifactSignalLimits,
  artifactTitleSchema,
} from '@repo/domain/artifacts'
import { z } from 'zod'

import {
  createGalleryArtifact,
  galleryOf,
  restoreGalleryArtifact,
  trashGalleryArtifact,
} from '../services/artifacts/gallery.ts'
import { chatContextOf } from '../services/chat/context.ts'

import {
  artifactPresence,
  leaveArtifact,
  markArtifactPresence,
  readArtifactSignals,
  type ArtifactPresence,
} from '../services/artifacts/signals.ts'
import { consentedProcedure, router } from '../trpc.ts'

// Artifacts in the cabinet (docs/plan/88-artifacts.md, §7.4, §7.9): the gallery and «Создать»
// (88.9), the live channel and presence (88.5); the editor, the tabs, the history and the bridge
// to pages come with their slices.

const artifactId = z.uuid()

const presenceOutput = z.strictObject({
  people: z.array(
    z.strictObject({
      userId: z.uuid(),
      name: z.string(),
      block: z.string().nullable(),
      self: z.boolean(),
    }),
  ),
  morePeople: z.number().int().min(0),
  agents: z.array(
    z.strictObject({
      label: z.string(),
      own: z.boolean(),
      blocks: z.array(z.strictObject({ key: z.string(), intent: z.string().nullable() })),
    }),
  ),
}) satisfies z.ZodType<ArtifactPresence>

/** No Redis here: nobody is shown, the page reads by its polls alone. */
const nobody: ArtifactPresence = { people: [], morePeople: 0, agents: [] }

const galleryRow = z.strictObject({
  id: z.uuid(),
  kind: z.string(),
  title: z.string(),
  project: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  version: z.number().int().min(0),
  blocks: z.number().int().min(0),
  excerpt: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  purgeAfter: z.iso.datetime().nullable(),
})

export const artifactRouter = router({
  /** The gallery (Ар50): the user's artifacts by a filter, a kind, a project and a word. */
  list: consentedProcedure
    .input(
      z.strictObject({
        filter: z.enum(artifactGalleryFilters),
        query: z.string().max(200).optional(),
        kind: z.enum(artifactKinds).nullable().optional(),
        projectId: z.uuid().nullable().optional(),
        sort: z.enum(artifactGallerySorts).optional(),
      }),
    )
    .output(z.array(galleryRow))
    .query(({ ctx, input }) => galleryOf(ctx.prisma, { userId: ctx.user.id, ...input })),

  /** «Создать» (A-create): an empty artifact, or one of a template; in a project or personal. */
  create: consentedProcedure
    .input(
      z.strictObject({
        kind: z.enum(artifactKinds),
        title: artifactTitleSchema,
        projectId: z.uuid().nullable(),
        templateId: z.string().max(40).nullable(),
      }),
    )
    .output(z.strictObject({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      createGalleryArtifact(ctx.prisma, {
        userId: ctx.user.id,
        appEnv: chatContextOf(ctx).appEnv,
        ...input,
      }),
    ),

  /** «В корзину» — only the owner; it goes for good after 30 days. */
  trash: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(z.strictObject({ purgeAfter: z.iso.datetime() }))
    .mutation(async ({ ctx, input }) => {
      const { purgeAfter } = await trashGalleryArtifact(ctx.prisma, {
        userId: ctx.user.id,
        ...input,
      })
      return { purgeAfter: purgeAfter.toISOString() }
    }),

  /** «Вернуть» from the trash. */
  restore: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(z.boolean())
    .mutation(({ ctx, input }) =>
      restoreGalleryArtifact(ctx.prisma, { userId: ctx.user.id, ...input }),
    ),

  /**
   * The signals of the artifacts one page watches (Ар20): `changes` — read
   * `artifact.changes({ sinceSeq })` of that artifact now, `presence` — read who is here,
   * `resync` — signals may have been missed, read all. Over SSE (`httpSubscriptionLink`); the
   * polls of the page go on, slower, as the fallback. Those the reader may not read are left
   * out; with none readable it is refused (NOT_FOUND), as when the last one is lost later.
   */
  signals: consentedProcedure
    .input(
      z.strictObject({
        artifactIds: z.array(artifactId).min(1).max(artifactSignalLimits.subscriptionArtifacts),
      }),
    )
    .subscription(async function* ({ ctx, input, signal }) {
      const signals = ctx.chat?.artifacts ?? null
      if (signals === null) return
      yield* readArtifactSignals(ctx.prisma, signals, {
        userId: ctx.user.id,
        artifactIds: input.artifactIds,
        ...(signal ? { signal } : {}),
      })
    }),

  /** The page is here, in a block or not (every 15 s); answers who else is. */
  here: consentedProcedure
    .input(z.strictObject({ artifactId, block: artifactBlockKeySchema.nullable() }))
    .output(presenceOutput)
    .mutation(async ({ ctx, input }) => {
      const signals = ctx.chat?.artifacts ?? null
      if (signals === null) return nobody
      return markArtifactPresence(ctx.prisma, signals, { userId: ctx.user.id, ...input })
    }),

  /** The page is closed: its mark goes at once, not after 30 s. */
  leave: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .mutation(async ({ ctx, input }) => {
      const signals = ctx.chat?.artifacts ?? null
      if (signals === null) return
      await leaveArtifact(ctx.prisma, signals, { userId: ctx.user.id, ...input })
    }),

  /** Who has the artifact open, and which agents write in it (after a `presence` signal). */
  presence: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(presenceOutput)
    .query(async ({ ctx, input }) => {
      const signals = ctx.chat?.artifacts ?? null
      if (signals === null) return nobody
      return artifactPresence(ctx.prisma, signals, { userId: ctx.user.id, ...input })
    }),
})
