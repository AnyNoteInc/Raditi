import { createHash } from 'node:crypto'

import { clientIp } from '@repo/auth'
import {
  acceptArtifactInvite,
  addArtifactCommentReply,
  admitInWindow,
  artifactAccessState,
  artifactCopyAllowedFor,
  closeArtifactAccess,
  createArtifactLink,
  declineArtifactInvite,
  inviteToArtifact,
  leaveArtifactAccess,
  myArtifactInvites,
  openArtifactLink,
  removeArtifactRecipient,
  revokeArtifactInvite,
  revokeArtifactLink,
  setArtifactCopyAllowed,
  setArtifactRecipientRole,
  artifactGalleryFilters,
  artifactGallerySorts,
  moveArtifact,
  resolveArtifactComment,
} from '@repo/db'
import { feedEventIdSchema } from '@repo/domain'
import {
  artifactBlockKeySchema,
  artifactCommentBodySchema,
  artifactHoldReasons,
  artifactKinds,
  artifactCommentAnchorInputSchema,
  artifactCommentAnchorSchema,
  artifactGrantRoles,
  artifactInviteEmailSchema,
  artifactInviteKindWord,
  artifactLinkTokenSchema,
  artifactOpenGrantRoles,
  artifactSharingClosed,
  artifactSharingOpen,
  artifactRoles,
  artifactSignalLimits,
  artifactTitleSchema,
  artifactExportFormats,
} from '@repo/domain/artifacts'
import { enqueueNotification } from '@repo/notifications'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { canvasThumbs } from '../services/artifacts/canvas.ts'
import { chatArtifactsOf } from '../services/artifacts/chat-artifacts.ts'
import {
  commentDispatchChats,
  commentDispatchInput,
  dispatchArtifactComments,
} from '../services/artifacts/comment-dispatch.ts'
import { cabinetComments, createCabinetComment } from '../services/artifacts/comments.ts'
import {
  cabinetChanges,
  cabinetRestore,
  cabinetRestorePreview,
  cabinetTurnArtifacts,
  cabinetUndoTurn,
  cabinetVersion,
  cabinetVersions,
} from '../services/artifacts/history.ts'
import {
  copyArtifactForRecipient,
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
  cabinetArtifactFiles,
  editArtifactText,
  importChatFileAsArtifact,
  issueArtifactFrame,
  startCabinetArtifactFile,
} from '../services/artifacts/frame.ts'
import { artifactExportStatus, startArtifactExport } from '../services/artifacts/exports.ts'

import {
  artifactPresence,
  leaveArtifact,
  markArtifactPresence,
  readArtifactSignals,
  type ArtifactPresence,
} from '../services/artifacts/signals.ts'
import { consentedProcedure, router, type Context } from '../trpc.ts'

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
      parent: z.string().nullable(),
      rank: z.string(),
      rev: z.number().int().min(0),
      heading: z.string().nullable(),
      props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
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

/** The flag of production (Э9, 88.16а): until it is on, nobody is given access there. */
function requireSharing(ctx: Context) {
  if (!artifactSharingOpen(chatContextOf(ctx).appEnv)) throw artifactSharingClosed()
}

export const artifactRouter = router({
  /** The page of an artifact (Ар48): the checked text of its blocks and who holds each. */
  read: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(readOutput)
    .query(({ ctx, input }) => readCabinetArtifact(ctx.prisma, { userId: ctx.user.id, ...input })),

  comments: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(
      z.array(
        z.strictObject({
          id: z.uuid(),
          anchor: artifactCommentAnchorSchema,
          body: artifactCommentBodySchema,
          shared: z.boolean(),
          author: z.strictObject({ name: z.string(), own: z.boolean() }),
          resolved: z.boolean(),
          moved: z.boolean(),
          replies: z.array(
            z.strictObject({
              id: z.uuid(),
              body: artifactCommentBodySchema,
              createdAt: z.iso.datetime(),
              /** A reply of the owner's agent, shown after the check of core (88.18г). */
              byAgent: z.boolean(),
              /** Who wrote it, in a thread of all (88.17а); empty of an agent. */
              authorName: z.string(),
              own: z.boolean(),
            }),
          ),
        }),
      ),
    )
    .query(({ ctx, input }) => cabinetComments(ctx.prisma, { userId: ctx.user.id, ...input })),

  addComment: consentedProcedure
    .input(
      z.strictObject({
        artifactId,
        anchor: artifactCommentAnchorInputSchema,
        body: artifactCommentBodySchema,
        /** A thread everyone with access sees (88.17а); absent — a private note of the owner. */
        shared: z.boolean().optional(),
      }),
    )
    .output(z.strictObject({ id: z.uuid() }))
    .mutation(({ ctx, input }) => {
      if (input.shared) requireSharing(ctx)
      return createCabinetComment(ctx.prisma, {
        userId: ctx.user.id,
        ...input,
        origin: { ip: clientIp(ctx.headers) },
      })
    }),

  addCommentReply: consentedProcedure
    .input(
      z.strictObject({
        artifactId,
        threadId: z.uuid(),
        requestId: z.uuid(),
        body: artifactCommentBodySchema,
      }),
    )
    .output(z.strictObject({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      addArtifactCommentReply(ctx.prisma, {
        userId: ctx.user.id,
        ...input,
        origin: { ip: clientIp(ctx.headers) },
      }),
    ),

  commentDispatchChats: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(z.array(z.strictObject({ taskId: z.uuid(), title: z.string().nullable() })))
    .query(({ ctx, input }) => commentDispatchChats(ctx.prisma, ctx.user.id, input.artifactId)),

  dispatchComments: consentedProcedure
    .input(commentDispatchInput)
    .output(
      z.strictObject({
        taskId: z.uuid(),
        requestEventId: feedEventIdSchema,
        repeated: z.boolean(),
      }),
    )
    .mutation(({ ctx, input }) =>
      dispatchArtifactComments(ctx.prisma, chatContextOf(ctx), ctx.user.id, input, new Date()),
    ),

  resolveComment: consentedProcedure
    .input(z.strictObject({ artifactId, commentId: z.uuid(), resolved: z.boolean() }))
    .mutation(({ ctx, input }) =>
      resolveArtifactComment(ctx.prisma, { userId: ctx.user.id, ...input }),
    ),

  /**
   * A batch of a person (§7.2): applied at once or refused whole — `ARTIFACT_STALE` with the
   * current block, `ARTIFACT_BLOCK_HELD` while an agent holds it, `ARTIFACT_SECRET_SHAPE`.
   */
  write: consentedProcedure
    .input(z.strictObject({ batch: z.unknown() }))
    .output(opsAnswer)
    .mutation(({ ctx, input }) =>
      applyCabinetOps(ctx.prisma, {
        userId: ctx.user.id,
        batch: input.batch,
        // Where the write came from, for the facts of a shared artifact (Ар56).
        origin: { ip: clientIp(ctx.headers) },
      }),
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

  /** The artifacts of a chat by group, for its «+», its tabs and «Результаты» (Ар44, Ар46). */
  ofChat: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(
      z.array(
        z.strictObject({
          id: z.uuid(),
          kind: z.string(),
          title: z.string(),
          version: z.number().int().min(0),
          group: z.enum(['made', 'mentioned', 'project']),
        }),
      ),
    )
    .query(({ ctx, input }) => chatArtifactsOf(ctx.prisma, { userId: ctx.user.id, ...input })),

  /** «История версий» (Ар13, D-history): the versions, newest first. */
  versions: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(
      z.array(
        z.strictObject({
          no: z.number().int().min(1),
          label: z.string().nullable(),
          named: z.boolean(),
          author: z.enum(['user', 'turn', 'schedule']),
          chat: z.string().nullable(),
          taskId: z.uuid().nullable(),
          turnNo: z.number().int().nullable(),
          createdAt: z.iso.datetime(),
          current: z.boolean(),
        }),
      ),
    )
    .query(({ ctx, input }) => cabinetVersions(ctx.prisma, { userId: ctx.user.id, ...input })),

  /** One version to read and compare. */
  version: consentedProcedure
    .input(z.strictObject({ artifactId, no: z.number().int().min(1) }))
    .output(
      z.strictObject({
        no: z.number().int().min(1),
        label: z.string().nullable(),
        createdAt: z.iso.datetime(),
        blocks: z.array(
          z.strictObject({
            key: z.string(),
            kind: z.string().nullable(),
            heading: z.string().nullable(),
            content: z.string().nullable(),
          }),
        ),
      }),
    )
    .query(({ ctx, input }) => cabinetVersion(ctx.prisma, { userId: ctx.user.id, ...input })),

  /** «Все изменения» (D-history): the journal, newest first, without text. */
  changes: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(
      z.array(
        z.strictObject({
          seq: z.number().int(),
          kind: z.string(),
          block: z.string().nullable(),
          result: z.string(),
          author: z.discriminatedUnion('kind', [
            z.strictObject({ kind: z.literal('person'), name: z.string(), self: z.boolean() }),
            z.strictObject({ kind: z.literal('agent'), chat: z.string().nullable() }),
          ]),
          taskId: z.uuid().nullable(),
          turnNo: z.number().int().nullable(),
          createdAt: z.iso.datetime(),
        }),
      ),
    )
    .query(({ ctx, input }) => cabinetChanges(ctx.prisma, { userId: ctx.user.id, ...input })),

  /** What «Вернуть эту версию» overwrites, before the owner confirms (Ар13). */
  restorePreview: consentedProcedure
    .input(z.strictObject({ artifactId, no: z.number().int().min(1) }))
    .output(
      z.strictObject({
        blocks: z.number().int().min(0),
        people: z.array(z.string()),
        chats: z.array(z.string()),
        agents: z.number().int().min(0),
        held: z.number().int().min(0),
      }),
    )
    .query(({ ctx, input }) =>
      cabinetRestorePreview(ctx.prisma, { userId: ctx.user.id, ...input }),
    ),

  /** «Вернуть эту версию» — only the owner; a new version. */
  restoreVersion: consentedProcedure
    .input(z.strictObject({ artifactId, no: z.number().int().min(1) }))
    .output(z.strictObject({ no: z.number().int().min(0), changed: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => cabinetRestore(ctx.prisma, { userId: ctx.user.id, ...input })),

  /** The artifacts a turn of a chat changed: `/undo` offers to take their edits back (Ар13). */
  turnArtifacts: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), turnNo: z.number().int().min(1) }))
    .output(z.array(z.strictObject({ id: z.uuid(), title: z.string() })))
    .query(({ ctx, input }) => cabinetTurnArtifacts(ctx.prisma, { userId: ctx.user.id, ...input })),

  /** «Отменить правки этого хода» (Ар13): the blocks nobody changed since go back. */
  undoTurn: consentedProcedure
    .input(z.strictObject({ artifactId, taskId: z.uuid(), turnNo: z.number().int().min(1) }))
    .output(z.strictObject({ undone: z.number().int().min(0), kept: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => cabinetUndoTurn(ctx.prisma, { userId: ctx.user.id, ...input })),

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

  /**
   * The gallery (Ар50): the user's artifacts by a filter, a kind, a project and a word, a page at
   * a time — `cursor` is the last card of the page before (its id, `updatedAt` and title).
   */
  list: consentedProcedure
    .input(
      z.strictObject({
        filter: z.enum(artifactGalleryFilters),
        query: z.string().max(200).optional(),
        kind: z.enum(artifactKinds).nullable().optional(),
        projectId: z.uuid().nullable().optional(),
        sort: z.enum(artifactGallerySorts).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z
          .strictObject({ id: z.uuid(), updatedAt: z.iso.datetime(), title: z.string().max(1000) })
          .nullish(),
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

  // ———— access of other users (Ар33–Ар36, slice 88.16-1), behind the flag of production

  /** «Поделиться»: the live link and those with access — only the owner. */
  shareState: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(
      z.strictObject({
        link: z
          .strictObject({
            role: z.enum(artifactGrantRoles),
            createdAt: z.iso.datetime(),
            expiresAt: z.iso.datetime().nullable(),
            opens: z.number().int().min(0),
          })
          .nullable(),
        people: z.array(
          z.strictObject({
            userId: z.uuid(),
            name: z.string(),
            email: z.string(),
            role: z.enum(artifactRoles),
            sources: z.array(z.enum(['invite', 'link'])),
          }),
        ),
        invites: z.array(
          z.strictObject({
            id: z.uuid(),
            email: z.string(),
            role: z.enum(artifactGrantRoles),
            createdAt: z.iso.datetime(),
          }),
        ),
        copyAllowed: z.boolean(),
      }),
    )
    .query(async ({ ctx, input }) => {
      requireSharing(ctx)
      const state = await artifactAccessState(ctx.prisma, {
        userId: ctx.user.id,
        artifactId: input.artifactId,
        now: new Date(),
      })
      return {
        link: state.link && {
          role: state.link.role as (typeof artifactGrantRoles)[number],
          createdAt: state.link.createdAt.toISOString(),
          expiresAt: state.link.expiresAt?.toISOString() ?? null,
          opens: state.link.opens,
        },
        people: state.people,
        invites: state.invites.map((invite) => ({
          ...invite,
          role: invite.role as (typeof artifactGrantRoles)[number],
          createdAt: invite.createdAt.toISOString(),
        })),
        copyAllowed: state.copyAllowed,
      }
    }),

  /** «Разрешить копию» (§7.8, 88.16-4): only the owner. */
  shareSetCopy: consentedProcedure
    .input(z.strictObject({ artifactId, allowed: z.boolean() }))
    .output(z.strictObject({ allowed: z.boolean() }))
    .mutation(({ ctx, input }) => {
      requireSharing(ctx)
      return setArtifactCopyAllowed(ctx.prisma, { userId: ctx.user.id, ...input })
    }),

  /** What a recipient may do beside reading: a copy of their own. */
  shareMine: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(z.strictObject({ copyAllowed: z.boolean() }))
    .query(async ({ ctx, input }) => {
      if (!artifactSharingOpen(chatContextOf(ctx).appEnv)) return { copyAllowed: false }
      return {
        copyAllowed: await artifactCopyAllowedFor(ctx.prisma, { userId: ctx.user.id, ...input }),
      }
    }),

  /** «Сделать копию» of a recipient: a new artifact of their personal workspace. */
  shareCopy: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(z.strictObject({ id: z.uuid() }))
    .mutation(({ ctx, input }) => {
      requireSharing(ctx)
      return copyArtifactForRecipient(ctx.prisma, {
        userId: ctx.user.id,
        appEnv: chatContextOf(ctx).appEnv,
        artifactId: input.artifactId,
      })
    }),

  /**
   * «Пригласить» by an address (Ар35): the letter goes to the outbox in the same transaction, with
   * our words only. The answer never tells whether the address has an account.
   */
  shareInvite: consentedProcedure
    .input(
      z.strictObject({
        artifactId,
        email: artifactInviteEmailSchema,
        role: z.enum(artifactOpenGrantRoles),
      }),
    )
    .output(z.strictObject({ sent: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      requireSharing(ctx)
      const appUrl = chatContextOf(ctx).appUrl
      if (!appUrl) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'No APP_URL' })
      await ctx.prisma.$transaction(async (tx) => {
        const sent = await inviteToArtifact(tx, {
          userId: ctx.user.id,
          artifactId: input.artifactId,
          email: input.email,
          role: input.role,
          now: new Date(),
        })
        await enqueueNotification(
          'artifact.invite',
          {
            to: input.email,
            inviterName: sent.inviterName,
            kindWord: artifactInviteKindWord(sent.kind),
            url: `${appUrl}/artifacts?invites=1`,
          },
          { db: tx, dedupeKey: `artifact.invite:${sent.inviteId}` },
        )
      })
      return { sent: true as const }
    }),

  shareInviteRevoke: consentedProcedure
    .input(z.strictObject({ artifactId, inviteId: z.uuid() }))
    .output(z.strictObject({ revoked: z.boolean() }))
    .mutation(({ ctx, input }) => {
      requireSharing(ctx)
      return revokeArtifactInvite(ctx.prisma, { userId: ctx.user.id, ...input, now: new Date() })
    }),

  /** «Приглашения» of the signed-in user: those to their confirmed address. */
  myInvites: consentedProcedure
    .output(
      z.array(
        z.strictObject({
          inviteId: z.uuid(),
          artifactId: z.uuid(),
          kind: z.string(),
          title: z.string(),
          ownerName: z.string(),
          role: z.enum(artifactGrantRoles),
        }),
      ),
    )
    .query(async ({ ctx }) => {
      if (!artifactSharingOpen(chatContextOf(ctx).appEnv)) return []
      const rows = await myArtifactInvites(ctx.prisma, { userId: ctx.user.id, now: new Date() })
      return rows.map((row) => ({ ...row, role: row.role as (typeof artifactGrantRoles)[number] }))
    }),

  inviteAccept: consentedProcedure
    .input(z.strictObject({ inviteId: z.uuid() }))
    .output(z.strictObject({ artifactId: z.uuid(), role: z.enum(artifactRoles) }))
    .mutation(({ ctx, input }) => {
      requireSharing(ctx)
      return acceptArtifactInvite(ctx.prisma, {
        userId: ctx.user.id,
        ...input,
        now: new Date(),
        origin: { ip: clientIp(ctx.headers) },
      })
    }),

  inviteDecline: consentedProcedure
    .input(z.strictObject({ inviteId: z.uuid() }))
    .output(z.strictObject({ declined: z.boolean() }))
    .mutation(({ ctx, input }) => {
      requireSharing(ctx)
      return declineArtifactInvite(ctx.prisma, { userId: ctx.user.id, ...input, now: new Date() })
    }),

  /** «Новая ссылка»: the token once — the cabinet makes `/a#<token>`; the link before is revoked. */
  shareLink: consentedProcedure
    .input(
      z.strictObject({
        artifactId,
        role: z.enum(artifactOpenGrantRoles),
        term: z.union([z.literal(7), z.literal(30)]).nullable(),
      }),
    )
    .output(
      z.strictObject({ token: artifactLinkTokenSchema, expiresAt: z.iso.datetime().nullable() }),
    )
    .mutation(async ({ ctx, input }) => {
      requireSharing(ctx)
      const link = await createArtifactLink(ctx.prisma, {
        userId: ctx.user.id,
        artifactId: input.artifactId,
        role: input.role,
        term: input.term,
        now: new Date(),
      })
      return { token: link.token, expiresAt: link.expiresAt?.toISOString() ?? null }
    }),

  shareRevoke: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(z.strictObject({ revoked: z.boolean() }))
    .mutation(({ ctx, input }) => {
      requireSharing(ctx)
      return revokeArtifactLink(ctx.prisma, { userId: ctx.user.id, ...input, now: new Date() })
    }),

  shareSetRole: consentedProcedure
    .input(
      z.strictObject({ artifactId, recipientId: z.uuid(), role: z.enum(artifactOpenGrantRoles) }),
    )
    .output(z.strictObject({ changed: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => {
      requireSharing(ctx)
      return setArtifactRecipientRole(ctx.prisma, { userId: ctx.user.id, ...input })
    }),

  shareRemove: consentedProcedure
    .input(z.strictObject({ artifactId, recipientId: z.uuid() }))
    .output(z.strictObject({ removed: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => {
      requireSharing(ctx)
      return removeArtifactRecipient(ctx.prisma, { userId: ctx.user.id, ...input })
    }),

  /** «Закрыть доступ всем»: the links revoked, every grant gone, in one transaction. */
  shareCloseAll: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(z.strictObject({ links: z.number().int().min(0), grants: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => {
      requireSharing(ctx)
      return closeArtifactAccess(ctx.prisma, { userId: ctx.user.id, ...input, now: new Date() })
    }),

  /**
   * «Открыть» by the token of a link, after sign-in and consent (Ар33): a POST, never a GET. At
   * most 30 opens an hour per address and per user — a guess of tokens goes nowhere.
   */
  shareOpen: consentedProcedure
    .input(z.strictObject({ token: artifactLinkTokenSchema }))
    .output(z.strictObject({ artifactId: z.uuid(), role: z.enum(artifactRoles) }))
    .mutation(async ({ ctx, input }) => {
      requireSharing(ctx)
      const now = Date.now()
      const address = createHash('sha256').update(input.token).digest('hex').slice(0, 32)
      for (const key of [`artifact-open:${address}`, `artifact-open-user:${ctx.user.id}`])
        if (!(await admitInWindow(ctx.prisma, { key, limit: 30, windowMs: 60 * 60_000, now })))
          throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many opens of links' })
      return openArtifactLink(ctx.prisma, {
        token: input.token,
        userId: ctx.user.id,
        now: new Date(),
        origin: { ip: clientIp(ctx.headers) },
      })
    }),

  /** «Выйти» of a recipient. */
  shareLeave: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(z.strictObject({ left: z.boolean() }))
    .mutation(({ ctx, input }) => {
      requireSharing(ctx)
      return leaveArtifactAccess(ctx.prisma, { userId: ctx.user.id, ...input })
    }),

  /**
   * «Перенести в проект…» and «Сделать личным» (Ар42): only the owner; `projectId` null — personal.
   * ARTIFACT_PROJECT_UNAVAILABLE — not a live project of the owner here, out of «Архив».
   */
  move: consentedProcedure
    .input(z.strictObject({ artifactId, projectId: z.uuid().nullable() }))
    .output(z.strictObject({ moved: z.boolean() }))
    .mutation(({ ctx, input }) =>
      moveArtifact(ctx.prisma, {
        userId: ctx.user.id,
        artifactId: input.artifactId,
        projectId: input.projectId?.toLowerCase() ?? null,
      }),
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

  /**
   * «Скачать» built by core (§7.13, question 26): the PDF and the PPTX of «Презентация» (88.25в),
   * the PNG of a picture of «Изображение» (88.26).
   */
  exportStart: consentedProcedure
    .input(
      z.strictObject({
        artifactId,
        format: z.enum(artifactExportFormats),
        /** The picture of «Изображение» a PNG draws (88.26). */
        frame: artifactBlockKeySchema.optional(),
      }),
    )
    .output(z.strictObject({ exportId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      startArtifactExport(ctx.prisma, { userId: ctx.user.id, ...input }),
    ),

  /** How an export goes; `ready` — `/api/artifact-exports/<id>` gives it to this person. */
  exportStatus: consentedProcedure
    .input(z.strictObject({ exportId: z.uuid() }))
    .output(z.strictObject({ state: z.enum(['pending', 'ready', 'failed']) }))
    .query(({ ctx, input }) => artifactExportStatus(ctx.prisma, { userId: ctx.user.id, ...input })),

  /**
   * The address of a frame (a screen of a canvas, a slide, a picture) for this viewer, five minutes
   * (Ар28, Ар9): `view` — on the root of the domain of pages, with its scripts; `edit` — the edit
   * frame of the cabinet, none.
   */
  frame: consentedProcedure
    .input(
      z.strictObject({
        artifactId,
        mode: z.enum(['view', 'edit']),
        // The `seq` the cabinet read: a new one is a new document of the frame, a new address.
        seq: z.number().int().min(0).optional(),
        /** The frame block: a screen of a canvas (slice 88.15), a slide, a picture. */
        frame: artifactBlockKeySchema,
      }),
    )
    .output(z.strictObject({ url: z.string(), expiresAt: z.iso.datetime() }))
    .query(({ ctx, input }) =>
      issueArtifactFrame(ctx.prisma, ctx.chat ?? null, {
        userId: ctx.user.id,
        artifactId: input.artifactId,
        mode: input.mode,
        frame: input.frame,
      }),
    ),

  /**
   * The thumbnails of the screens of a canvas (§7.7, slice 88.15): an address of each drawn one,
   * null for the rest — core is asked to draw them, the board asks again while any is missing.
   */
  canvasThumbs: consentedProcedure
    .input(z.strictObject({ artifactId, seq: z.number().int().min(0).optional() }))
    .output(
      z.strictObject({
        thumbs: z.array(
          z.strictObject({
            frame: z.string(),
            width: z.number().int(),
            url: z.string().nullable(),
          }),
        ),
        pending: z.boolean(),
      }),
    )
    .query(({ ctx, input }) => {
      const chat = chatContextOf(ctx)
      return canvasThumbs(ctx.prisma, chat.storage(), {
        userId: ctx.user.id,
        artifactId: input.artifactId,
      })
    }),

  /** «Править текст» (Ар9): the slots of text of one element, plain text, under `ifRev`. */
  editText: consentedProcedure
    .input(
      z.strictObject({
        artifactId,
        block: artifactBlockKeySchema,
        ifRev: z.number().int().min(0),
        element: z.string().min(3).max(60),
        shape: z.array(z.string().max(120)).max(500),
        edits: z
          .array(
            z.strictObject({
              slot: z.number().int().min(0).max(500),
              text: z.string().max(8000),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .output(opsAnswer)
    .mutation(({ ctx, input }) => editArtifactText(ctx.prisma, { userId: ctx.user.id, ...input })),

  /** The files of an artifact (Ар12): pictures and fonts its content names `artifact-file:<id>`. */
  files: consentedProcedure
    .input(z.strictObject({ artifactId }))
    .output(
      z.array(
        z.strictObject({
          id: z.uuid(),
          ref: z.string(),
          name: z.string(),
          type: z.string(),
          bytes: z.number().int().min(0),
          createdAt: z.iso.datetime(),
        }),
      ),
    )
    .query(({ ctx, input }) => cabinetArtifactFiles(ctx.prisma, { userId: ctx.user.id, ...input })),

  /** «Загрузить файл»: a row for the bytes `PUT /api/artifact-files/<id>` brings. */
  fileStart: consentedProcedure
    .input(
      z.strictObject({
        artifactId,
        name: z.string().min(1).max(200),
        sizeBytes: z
          .number()
          .int()
          .min(1)
          .max(5 * 1024 * 1024),
      }),
    )
    .output(z.strictObject({ fileId: z.uuid(), ref: z.string(), uploadUrl: z.string() }))
    .mutation(({ ctx, input }) =>
      startCabinetArtifactFile(ctx.prisma, { userId: ctx.user.id, ...input }),
    ),

  /** «Открыть как артефакт» of a `.md` (a document) or `.html`, `.htm`, `.svg` (a canvas) file (Ар3). */
  importFile: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), fileId: z.uuid() }))
    .output(z.strictObject({ id: z.uuid() }))
    .mutation(({ ctx, input }) => {
      const chat = chatContextOf(ctx)
      return importChatFileAsArtifact(ctx.prisma, chat.storage(), { userId: ctx.user.id, ...input })
    }),
})
