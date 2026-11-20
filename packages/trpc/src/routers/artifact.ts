import { artifactBlockKeySchema, artifactSignalLimits } from '@repo/domain/artifacts'
import { z } from 'zod'

import {
  artifactPresence,
  leaveArtifact,
  markArtifactPresence,
  readArtifactSignals,
  type ArtifactPresence,
} from '../services/artifacts/signals.ts'
import { consentedProcedure, router } from '../trpc.ts'

// Artifacts in the cabinet (docs/plan/88-artifacts.md, §7.4, §7.9): the live channel and presence
// of slice 88.5; the operations, the gallery and the editor come with their slices.

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

export const artifactRouter = router({
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
