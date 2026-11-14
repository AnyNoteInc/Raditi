import {
  DomainError,
  pageKinds,
  pageLimits,
  pageTitleSchema,
  type PagesAddress,
} from '@repo/domain'
import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import {
  cabinetDocument,
  canPublishOfChat,
  listCabinetPages,
  publishChatFilePage,
  publishDocumentPage,
  restoreCabinetPage,
  setCabinetPagePassword,
  takeDownCabinetPage,
} from '../services/pages.ts'
import { consentedProcedure, router } from '../trpc.ts'

// «Страницы» of the cabinet (docs/plan/69-pages.md, Ст13–Ст15, Ст30): the pages of the user's
// workspaces and what the client alone does with them — the password, taking a page down and
// putting it back. The agent has none of these (Ст20).

const pageOutput = z.strictObject({
  pageId: z.uuid(),
  workspaceId: z.uuid(),
  title: pageTitleSchema,
  url: z.url(),
  kind: z.enum(pageKinds),
  state: z.enum(['pending', 'live', 'taken_down']),
  version: z.number().int().min(0),
  hasPassword: z.boolean(),
  takenDownBy: z.enum(['client', 'operator']).nullable(),
  chat: z.strictObject({ id: z.uuid(), title: z.string().nullable() }).nullable(),
  canManage: z.boolean(),
  updatedAt: z.iso.datetime(),
})
const pageInput = z.strictObject({ pageId: z.uuid() })
const publicationOutput = z.strictObject({
  pageId: z.uuid(),
  url: z.url(),
  version: z.number().int().min(1),
})

export const pagesRouter = router({
  /** `enabled` false — PAGES_BASE_DOMAIN is unset here: no pages. */
  list: consentedProcedure
    .output(z.strictObject({ enabled: z.boolean(), pages: z.array(pageOutput) }))
    .query(async ({ ctx }) => {
      const address = ctx.chat?.pages ?? null
      if (address === null) return { enabled: false, pages: [] }
      return { enabled: true, pages: await listCabinetPages(ctx.prisma, address, ctx.user.id) }
    }),

  /** A document for its live card and its full view: checked text only (Ст19, Ст22). */
  doc: consentedProcedure
    .input(z.strictObject({ docId: z.uuid() }))
    .output(
      z.strictObject({
        docId: z.uuid(),
        title: z.string(),
        version: z.number().int().min(0),
        revision: z.number().int().min(1),
        progress: z.strictObject({
          written: z.number().int().min(0),
          total: z.number().int().min(0),
        }),
        sections: z.array(
          z.strictObject({
            key: z.string(),
            intent: z.string(),
            state: z.enum(['pending', 'unchecked', 'shown']),
            heading: z.string().nullable(),
            markdown: z.string().nullable(),
          }),
        ),
        page: z
          .strictObject({ pageId: z.uuid(), state: z.string(), version: z.number().int().min(0) })
          .nullable(),
        // The owner or an administrator, and pages set up here: «Опубликовать по ссылке» shows.
        canPublish: z.boolean(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { canManage, ...document } = await cabinetDocument(ctx.prisma, {
        documentId: input.docId,
        userId: ctx.user.id,
      })
      return { ...document, canPublish: canManage && (ctx.chat?.pages ?? null) !== null }
    }),

  /** Whether «Опубликовать как страницу» shows in the tab of this chat (Ст32). */
  canPublish: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(z.boolean())
    .query(async ({ ctx, input }) =>
      (ctx.chat?.pages ?? null) === null
        ? false
        : canPublishOfChat(ctx.prisma, { taskId: input.taskId, userId: ctx.user.id }),
    ),

  /** The password of a page; null clears it. A new one stops the viewers' former cookies. */
  setPassword: consentedProcedure
    .input(
      pageInput.extend({
        password: z
          .string()
          .min(pageLimits.passwordMinChars)
          // A bound on UTF-16 units only: the bounds in characters are pagePasswordProblem's.
          .max(pageLimits.passwordMaxChars * 2)
          .nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      setCabinetPagePassword(ctx.prisma, { ...input, userId: ctx.user.id }),
    ),

  takeDown: consentedProcedure
    .input(pageInput)
    .mutation(({ ctx, input }) =>
      takeDownCabinetPage(ctx.prisma, { ...input, userId: ctx.user.id }),
    ),

  /** «Опубликовать по ссылке» of a document: its current version, now (Ст25). */
  publishDoc: consentedProcedure
    .input(z.strictObject({ docId: z.uuid() }))
    .output(publicationOutput)
    .mutation(({ ctx, input }) =>
      publishDocumentPage(ctx.prisma, pagesAddressOf(ctx), {
        documentId: input.docId,
        userId: ctx.user.id,
      }),
    ),

  /** «Опубликовать как страницу» of a `.html` or `.md` of the chat (Ст32). */
  publishFile: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), fileId: z.uuid() }))
    .output(publicationOutput)
    .mutation(({ ctx, input }) =>
      publishChatFilePage(ctx.prisma, chatContextOf(ctx).storage(), pagesAddressOf(ctx), {
        ...input,
        userId: ctx.user.id,
      }),
    ),

  restore: consentedProcedure
    .input(pageInput)
    .mutation(({ ctx, input }) =>
      restoreCabinetPage(ctx.prisma, { ...input, userId: ctx.user.id }),
    ),
})

/** The address of the pages here; none — publications are off (PAGES_BASE_DOMAIN unset). */
function pagesAddressOf(ctx: { chat?: { pages?: PagesAddress | null } | null }): PagesAddress {
  const address = ctx.chat?.pages ?? null
  if (address === null) throw new DomainError('PAGES_OFF', 'Pages are not set up here', 409)
  return address
}
