import { artifactGalleryFilters, artifactGallerySorts } from '@repo/db'
import {
  artifactBlockKeySchema,
  artifactHoldReasons,
  artifactKinds,
  artifactRoles,
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
import {
  applyCabinetOps,
  cabinetArtifactChats,
  holdCabinetBlock,
  readCabinetArtifact,
  releaseCabinetBlock,
  saveCabinetVersion,
  takeCabinetBlock,
} from '../services/artifacts/editor.ts'
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

const blockInput = z.strictObject({ artifactId, block: artifactBlockKeySchema })

const readOutput = z.strictObject({
  id: z.uuid(),
  kind: z.string(),
  title: z.string(),
  seq: z.number().int().min(0),
  role: z.enum(artifactRoles),
  version: z.number().int().min(0),
  project: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  updatedAt: z.iso.datetime(),
  blocks: z.array(
    z.strictObject({
      key: z.string(),
      kind: z.string(),
      rank: z.string(),
      rev: z.number().int().min(0),
      heading: z.string().nullable(),
      content: z.string().nullable(),
      checking: z.boolean(),
      hold: z.enum(artifactHoldReasons).nullable(),
    }),
  ),
})

const opsAnswer = z.strictObject({
  artifactId: z.uuid(),
  opId: z.string(),
  seq: z.number().int().min(0),
  blocks: z.array(
    z.strictObject({
      key: z.string(),
      rev: z.number().int().min(0),
      state: z.enum(['applied', 'checking', 'deleted']),
    }),
  ),
  title: z.enum(['applied', 'checking']).nullable(),
  repeated: z.boolean(),
})

export const artifactRouter = router({
  /** The page of an artifact (Ар48): the checked text of its blocks and who holds each. */
  read: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(readOutput)
    .query(({ ctx, input }) => readCabinetArtifact(ctx.prisma, { userId: ctx.user.id, ...input })),

  /**
   * A batch of a person (§7.2): applied at once or refused whole — `ARTIFACT_STALE` with the
   * current block, `ARTIFACT_BLOCK_HELD` while an agent holds it, `ARTIFACT_SECRET_SHAPE`.
   */
  write: consentedProcedure
    .input(z.strictObject({ batch: z.unknown() }))
    .output(opsAnswer)
    .mutation(({ ctx, input }) =>
      applyCabinetOps(ctx.prisma, { userId: ctx.user.id, batch: input.batch }),
    ),

  /** A person types in a block (Ар17): it is held for them for 30 s, renewed by each call. */
  hold: consentedProcedure
    .input(blockInput)
    .output(z.strictObject({ rev: z.number().int().min(0), until: z.iso.datetime() }))
    .mutation(({ ctx, input }) => holdCabinetBlock(ctx.prisma, { userId: ctx.user.id, ...input })),

  /** The editor of a block closed: the person's lease ends now. */
  release: consentedProcedure
    .input(blockInput)
    .mutation(({ ctx, input }) =>
      releaseCabinetBlock(ctx.prisma, { userId: ctx.user.id, ...input }),
    ),

  /** «Забрать правку» (Ар16, Ар17). */
  take: consentedProcedure
    .input(blockInput)
    .output(z.strictObject({ rev: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => takeCabinetBlock(ctx.prisma, { userId: ctx.user.id, ...input })),

  /** «Сохранить текущую как версию…» (Ар13). */
  saveVersion: consentedProcedure
    .input(z.strictObject({ artifactId, label: z.string().trim().min(1).max(60) }))
    .output(z.strictObject({ no: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { no } = await saveCabinetVersion(ctx.prisma, { userId: ctx.user.id, ...input })
      return { no }
    }),

  /** The reader's own chats of this artifact, newest first (Ар48). */
  chats: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(
      z.array(
        z.strictObject({
          taskId: z.uuid(),
          title: z.string().nullable(),
          lastAt: z.iso.datetime(),
        }),
      ),
    )
    .query(({ ctx, input }) => cabinetArtifactChats(ctx.prisma, { userId: ctx.user.id, ...input })),

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
