import {
  releaseKinds,
  releaseOutcomes,
  releaseStatuses,
  undoFileChanges,
  undoItemVerdicts,
  versionBumps,
} from '@repo/domain'
import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import { confirmRelease, prepareRelease, readRelease } from '../services/chat/releases.ts'
import { confirmUndo, prepareUndo, readUndoPlan } from '../services/chat/undo.ts'
import { consentedProcedure, router } from '../trpc.ts'

const bump = z.enum(versionBumps)
const countsOutput = z
  .strictObject({
    files: z.strictObject({ added: z.number(), modified: z.number(), deleted: z.number() }),
    media: z.number(),
    records: z.number(),
  })
  .nullable()

export const releaseRouter = router({
  /**
   * `/release`, step one (Р25–Р27): what will be released and under which number, each number
   * with its confirmation. Owners and admins of the workspace only; nothing is written.
   */
  prepare: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(
      z.strictObject({
        candidateId: z.uuid(),
        revision: z.number().int(),
        counts: countsOutput,
        installedVersion: z.string().nullable(),
        base: z.string(),
        proposal: z.strictObject({ version: z.string(), bump }),
        choices: z.array(z.strictObject({ version: z.string(), bump, confirmToken: z.string() })),
        review: z.boolean(),
        expiresAt: z.date(),
      }),
    )
    .query(({ ctx, input }) =>
      prepareRelease(ctx.prisma, chatContextOf(ctx).releaseConfirmKey, {
        userId: ctx.user.id,
        taskId: input.taskId,
        now: new Date(),
      }),
    ),

  /** `/release`, step two: the confirmation of one number; a repeat returns the same release. */
  confirm: consentedProcedure
    .input(
      z.strictObject({
        taskId: z.uuid(),
        confirmToken: z.string().min(1).max(1024),
        version: z.string().max(32),
        /** The client looked at every change of the database (a bulk or shortened plan). */
        reviewed: z.boolean().optional(),
      }),
    )
    .output(
      z.strictObject({
        releaseId: z.uuid(),
        status: z.enum(releaseStatuses),
        version: z.string(),
        repeated: z.boolean(),
      }),
    )
    .mutation(({ ctx, input }) =>
      confirmRelease(ctx.prisma, chatContextOf(ctx).releaseConfirmKey, {
        ...input,
        userId: ctx.user.id,
        now: new Date(),
      }),
    ),

  /**
   * «Отменить выпуск», step one (docs/plan/53, «Отмена выпуска»): core is asked for the plan of
   * the undo of the release the dialog installed — or the plan still standing is found. Owners
   * and admins, while the site runs that release, within seven days of its installation.
   */
  undoPrepare: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), releaseId: z.uuid() }))
    .output(z.strictObject({ planId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      prepareUndo(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
    ),

  /** The plan of the undo: pending, failed, expired, or ready with its confirmation. */
  undoPlan: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), releaseId: z.uuid(), planId: z.uuid() }))
    .output(
      z.discriminatedUnion('state', [
        z.strictObject({ state: z.literal('pending') }),
        z.strictObject({ state: z.literal('expired') }),
        z.strictObject({
          state: z.literal('failed'),
          reason: z.enum(['site_unreachable', 'repository', 'technical']),
        }),
        z.strictObject({
          state: z.literal('ready'),
          planId: z.uuid(),
          releaseId: z.uuid(),
          undoneVersion: z.string(),
          returnsTo: z.string(),
          version: z.string(),
          until: z.date(),
          files: z.strictObject({
            back: z.number(),
            removed: z.number(),
            restored: z.number(),
            mediaKept: z.number(),
            paths: z.array(z.strictObject({ path: z.string(), change: z.enum(undoFileChanges) })),
            more: z.number(),
          }),
          records: z.array(
            z.strictObject({
              objectType: z.string(),
              objectId: z.string(),
              verdict: z.enum(undoItemVerdicts),
              text: z.string(),
            }),
          ),
          nothingToUndo: z.boolean(),
          review: z.boolean(),
          confirmToken: z.string(),
          expiresAt: z.date(),
        }),
      ]),
    )
    .query(({ ctx, input }) =>
      readUndoPlan(ctx.prisma, chatContextOf(ctx).releaseConfirmKey, {
        ...input,
        userId: ctx.user.id,
        now: new Date(),
      }),
    ),

  /** «Отменить выпуск», step two: the confirmation of the plan shown; a repeat — the same undo. */
  undoConfirm: consentedProcedure
    .input(
      z.strictObject({
        taskId: z.uuid(),
        releaseId: z.uuid(),
        confirmToken: z.string().min(1).max(1024),
        version: z.string().max(32),
        /** The client looked at every record the undo returns (more than twenty). */
        reviewed: z.boolean().optional(),
      }),
    )
    .output(
      z.strictObject({
        undoId: z.uuid(),
        status: z.enum(releaseStatuses),
        version: z.string(),
        repeated: z.boolean(),
      }),
    )
    .mutation(({ ctx, input }) =>
      confirmUndo(ctx.prisma, chatContextOf(ctx).releaseConfirmKey, {
        ...input,
        userId: ctx.user.id,
        now: new Date(),
      }),
    ),

  /** A release of a dialog: its status, step and outcome, and the steps the deploy reported. */
  get: consentedProcedure
    .input(z.strictObject({ releaseId: z.uuid() }))
    .output(
      z.strictObject({
        id: z.uuid(),
        taskId: z.uuid(),
        /** `undo` — «Отменить выпуск» of the release `undoesReleaseId`. */
        kind: z.enum(releaseKinds),
        undoesReleaseId: z.uuid().nullable(),
        version: z.string(),
        bump,
        status: z.enum(releaseStatuses),
        step: z.string().nullable(),
        outcome: z.enum(releaseOutcomes).nullable(),
        approvedAt: z.date(),
        createdAt: z.date(),
        updatedAt: z.date(),
        steps: z.array(z.strictObject({ step: z.string(), state: z.string(), at: z.date() })),
      }),
    )
    .query(({ ctx, input }) => readRelease(ctx.prisma, { ...input, userId: ctx.user.id })),
})
