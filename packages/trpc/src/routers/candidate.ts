import {
  candidateCheckStatuses,
  candidateFileChanges,
  candidateStatuses,
  dbContentFields,
  dbPlanViewSchema,
  previewRuntimeMatchSchema,
  versionBumps,
} from '@repo/domain'
import { z } from 'zod'

import { readFileDiff } from '../services/chat/candidate-diff.ts'
import { readCandidate } from '../services/chat/candidates.ts'
import { chatContextOf } from '../services/chat/context.ts'
import { taskNotFound } from '../services/chat/access.ts'
import { updateDialogCandidate } from '../services/chat/tasks.ts'
import { consentedProcedure, router } from '../trpc.ts'

const bump = z.enum(versionBumps)

const candidateOutput = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  revision: z.number().int(),
  status: z.enum(candidateStatuses),
  turnNo: z.number().int(),
  createdAt: z.date(),
  baseVersion: z.string().nullable(),
  files: z.array(
    z.strictObject({
      path: z.string(),
      change: z.enum(candidateFileChanges),
      sizeBytes: z.number().int(),
      executable: z.boolean(),
    }),
  ),
  media: z.array(
    z.strictObject({
      path: z.string(),
      contentType: z.string(),
      sizeBytes: z.number().int(),
      sha256: z.string(),
    }),
  ),
  database: z.array(
    z.strictObject({
      objectType: z.string(),
      objectId: z.string(),
      fields: z.array(z.enum(dbContentFields)),
      text: z.string(),
    }),
  ),
  databaseView: dbPlanViewSchema.nullable(),
  databaseReview: z.boolean(),
  checks: z.array(
    z.strictObject({
      id: z.uuid(),
      kind: z.string(),
      status: z.enum(candidateCheckStatuses),
      finishedAt: z.date().nullable(),
      screenshot: z.boolean(),
    }),
  ),
  runtime: previewRuntimeMatchSchema.nullable(),
  proposal: z.strictObject({
    base: z.string(),
    version: z.string(),
    bump,
    choices: z.array(z.strictObject({ version: z.string(), bump })),
  }),
})

export const candidateRouter = router({
  /**
   * The changes of a dialog for the panel to the right of it (Р20): files, media, the records of
   * the site, the checks and the number of a release. Without `revision` — the candidate the
   * dialog waits with; null when it has none.
   */
  get: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), revision: z.number().int().min(1).optional() }))
    .output(candidateOutput.nullable())
    .query(({ ctx, input }) => readCandidate(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** The unified diff of one file of a candidate, at most 256 KiB of it. */
  fileDiff: consentedProcedure
    .input(z.strictObject({ candidateId: z.uuid(), path: z.string().min(1).max(1024) }))
    .output(
      z.strictObject({
        path: z.string(),
        state: z.enum(['ready', 'binary', 'too_large', 'missing']),
        diff: z.string().nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const candidate = await ctx.prisma.taskCandidate.findFirst({
        where: {
          id: input.candidateId,
          task: { workspace: { members: { some: { userId: ctx.user.id } } } },
        },
        select: { taskId: true, revision: true, files: true },
      })
      if (candidate === null) throw taskNotFound()
      // Only a file of the candidate: the path names a part of the patch, nothing else.
      const files = Array.isArray(candidate.files) ? candidate.files : []
      const listed = files.some(
        (file) =>
          typeof file === 'object' &&
          file !== null &&
          (file as { path?: unknown }).path === input.path,
      )
      if (!listed) throw taskNotFound()
      return readFileDiff(chatContextOf(ctx).storage(), {
        taskId: candidate.taskId,
        revision: candidate.revision,
        path: input.path,
      })
    }),

  /** «Обновить» (`/update`): carries the candidate onto the current version of the site. */
  update: consentedProcedure
    .input(
      z.strictObject({ taskId: z.uuid(), requestId: z.uuid().transform((id) => id.toLowerCase()) }),
    )
    .output(z.strictObject({ requestEventId: z.string(), repeated: z.boolean() }))
    .mutation(({ ctx, input }) =>
      updateDialogCandidate(ctx.prisma, { ...input, userId: ctx.user.id }),
    ),
})
