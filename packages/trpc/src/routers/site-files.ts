import { siteFilePathSchema, siteFilesLimits } from '@repo/domain'
import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import {
  listSiteFiles,
  readSiteFile,
  saveSiteFile,
  siteFileEditState,
} from '../services/site-files.ts'
import { consentedProcedure, router } from '../trpc.ts'

// The section «Терминал» of a project (owner's request of 06.11.2026): the files of the version the
// site has and one of them to read (services/site-files.ts). Read only.

const siteInput = z.strictObject({
  siteId: z.uuid(),
  /** A chat with the code of the site: the working copy of its agent instead of the site's. */
  taskId: z.uuid().optional(),
})
const sha = z.string().regex(/^[0-9a-f]{40}$/)

export const siteFilesRouter = router({
  /** The files of the version the site has; `preparing` — core is reading them, ask again. */
  list: consentedProcedure
    .input(siteInput)
    .output(
      z.discriminatedUnion('state', [
        z.strictObject({ state: z.enum(['none', 'preparing']) }),
        z.strictObject({
          state: z.literal('ready'),
          sha,
          version: z.string().nullable(),
          changed: z.boolean(),
          truncated: z.boolean(),
          files: z.array(z.strictObject({ path: z.string(), size: z.number().int().min(0) })),
        }),
      ]),
    )
    .query(({ ctx, input }) =>
      listSiteFiles(ctx.prisma, chatContextOf(ctx).storage(), { ...input, userId: ctx.user.id }),
    ),

  /** One file of that version: its text, or why it is not shown. */
  read: consentedProcedure
    .input(siteInput.extend({ path: siteFilePathSchema, sha: sha.optional() }))
    .output(
      z.discriminatedUnion('state', [
        z.strictObject({
          state: z.enum(['none', 'preparing', 'missing', 'binary', 'too_large']),
        }),
        z.strictObject({ state: z.literal('ready'), text: z.string() }),
      ]),
    )
    .query(({ ctx, input }) =>
      readSiteFile(ctx.prisma, chatContextOf(ctx).storage(), { ...input, userId: ctx.user.id }),
    ),

  /**
   * The client's edit of a file of a chat's working copy: saved into the chat, committed by core
   * when its agent waits (`candidate.edit`); `editId` tells what came of it.
   */
  save: consentedProcedure
    .input(
      z.strictObject({
        siteId: z.uuid(),
        taskId: z.uuid(),
        path: siteFilePathSchema,
        baseSha: sha,
        text: z.string().max(siteFilesLimits.viewBytes),
      }),
    )
    .output(z.strictObject({ editId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      saveSiteFile(ctx.prisma, chatContextOf(ctx).storage(), { ...input, userId: ctx.user.id }),
    ),

  /** What came of an edit: `pending` until core answers it. */
  editState: consentedProcedure
    .input(z.strictObject({ siteId: z.uuid(), taskId: z.uuid(), editId: z.uuid() }))
    .output(
      z.discriminatedUnion('state', [
        z.strictObject({ state: z.literal('pending') }),
        z.strictObject({
          state: z.enum(['saved', 'conflict', 'refused', 'failed']),
          revision: z.number().int().nullable(),
        }),
      ]),
    )
    .query(({ ctx, input }) => siteFileEditState(ctx.prisma, { ...input, userId: ctx.user.id })),
})
