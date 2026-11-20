import {
  docViews,
  DomainError,
  pageKinds,
  pageFilePathSchema,
  pageLimits,
  pageNameSchema,
  pagePathSchema,
  pageSegmentSchema,
  pageTitleSchema,
  type PagesAddress,
} from '@repo/domain'
import { z } from 'zod'

import { artifactPublicationOf, publishArtifactPage } from '../services/artifacts/publish.ts'
import { chatContextOf } from '../services/chat/context.ts'
import {
  cabinetDocPage,
  cabinetDocVersion,
  cabinetDocVersions,
  cabinetDocument,
  cabinetSiteFiles,
  canPublishOfChat,
  deleteCabinetPage,
  deleteCabinetSiteFile,
  listCabinetPages,
  publishTargetsOfChat,
  publishChatFilePage,
  publishDocumentPage,
  purgeCabinetPage,
  restoreCabinetPage,
  nameCabinetSite,
  returnCabinetPage,
  updateCabinetPage,
  setCabinetPagePassword,
  takeDownCabinetPage,
} from '../services/pages.ts'
import { consentedProcedure, router } from '../trpc.ts'

// «Страницы» of the cabinet (docs/plan/69-pages.md, Ст13–Ст15, Ст30; docs/plan/73-pages-sites.md,
// Дер1–Дер8): the pages of the user's workspaces and what the client alone does with them — the
// password, taking a page down and putting it back, the trash. The agent has none of these (Ст20).

const pageOutput = z.strictObject({
  pageId: z.uuid(),
  workspaceId: z.uuid(),
  // Its site and its place in it (docs/plan/73-pages-sites.md, Дер11, Дер12).
  treeId: z.uuid(),
  parentId: z.uuid().nullable(),
  path: pagePathSchema,
  position: z.number().int().min(0),
  title: pageTitleSchema,
  url: z.url(),
  kind: z.enum(pageKinds),
  state: z.enum(['pending', 'live', 'taken_down']),
  version: z.number().int().min(0),
  hasPassword: z.boolean(),
  takenDownBy: z.enum(['client', 'operator']).nullable(),
  // In the trash (docs/plan/73-pages-sites.md, Дер2); a page names no chat (Дер8).
  trash: z.strictObject({ deletedAt: z.iso.datetime(), purgeAfter: z.iso.datetime() }).nullable(),
  // The file it was last published from: a hint for the client's choice (Дер9).
  sourceFileName: z.string().nullable(),
  canManage: z.boolean(),
  updatedAt: z.iso.datetime(),
  // The own name of its site, and whether the tariff gives names (docs/plan/73-pages-sites.md, Дер32).
  name: pageNameSchema.nullable(),
  namesAllowed: z.boolean(),
})
const pageInput = z.strictObject({ pageId: z.uuid() })
const publicationOutput = z.strictObject({
  pageId: z.uuid(),
  url: z.url(),
  version: z.number().int().min(1),
})

export const pagesRouter = router({
  /**
   * «Опубликовать как страницу» of an artifact (docs/plan/88-artifacts.md, Ар2, §7.10) — only its
   * owner: a version of it, the current one by default; again — «Обновить страницу».
   */
  publishArtifact: consentedProcedure
    .input(z.strictObject({ artifactId: z.uuid(), versionNo: z.number().int().min(1).nullable() }))
    .output(publicationOutput.extend({ versionNo: z.number().int().min(1) }))
    .mutation(({ ctx, input }) =>
      publishArtifactPage(ctx.prisma, pagesAddressOf(ctx), { ...input, userId: ctx.user.id }),
    ),

  /** The page an artifact became, if any: its address and the version it shows. */
  artifactPublication: consentedProcedure
    .input(z.strictObject({ artifactId: z.uuid() }))
    .output(
      z
        .strictObject({
          pageId: z.uuid(),
          url: z.url().nullable(),
          versionNo: z.number().int().min(1),
          current: z.boolean(),
        })
        .nullable(),
    )
    .query(({ ctx, input }) =>
      artifactPublicationOf(ctx.prisma, ctx.chat?.pages ?? null, { ...input, userId: ctx.user.id }),
    ),

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
        view: z.enum(docViews),
        version: z.number().int().min(0),
        revision: z.number().int().min(1),
        progress: z.strictObject({
          written: z.number().int().min(0),
          total: z.number().int().min(0),
        }),
        draft: z.boolean(),
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

  /**
   * The pages a file of this chat may become the next version of (docs/plan/73-pages-sites.md,
   * Дер9): of its workspace, live, of files.
   */
  targets: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(
      z.array(
        z.strictObject({
          pageId: z.uuid(),
          title: pageTitleSchema,
          version: z.number().int().min(1),
          sourceFileName: z.string().nullable(),
        }),
      ),
    )
    .query(({ ctx, input }) =>
      (ctx.chat?.pages ?? null) === null
        ? []
        : publishTargetsOfChat(ctx.prisma, { taskId: input.taskId, userId: ctx.user.id }),
    ),

  /**
   * The finished document of the view `page` as the tab beside the chat shows it (docs/plan/74,
   * Д1): its page to read; null — no version yet, or the view is `text`.
   */
  docPage: consentedProcedure
    // The version names what the tab shows: every version is read once, never an older page.
    .input(z.strictObject({ docId: z.uuid(), version: z.number().int().min(1) }))
    .output(z.strictObject({ html: z.string(), version: z.number().int().min(1) }).nullable())
    .query(({ ctx, input }) =>
      cabinetDocPage(ctx.prisma, { documentId: input.docId, userId: ctx.user.id }),
    ),

  /** The versions of a document, oldest first: the switch in the head of its view (14.11.2026). */
  docVersions: consentedProcedure
    .input(z.strictObject({ docId: z.uuid() }))
    .output(
      z.array(
        z.strictObject({
          no: z.number().int().min(1),
          createdAt: z.string(),
          kept: z.boolean(),
        }),
      ),
    )
    .query(({ ctx, input }) =>
      cabinetDocVersions(ctx.prisma, { documentId: input.docId, userId: ctx.user.id }),
    ),

  /** One version of a document; null — its text was not kept (finished before 14.11.2026). */
  docVersion: consentedProcedure
    .input(z.strictObject({ docId: z.uuid(), version: z.number().int().min(1) }))
    .output(
      z
        .strictObject({
          version: z.number().int().min(1),
          markdown: z.string(),
          html: z.string().nullable(),
        })
        .nullable(),
    )
    .query(({ ctx, input }) =>
      cabinetDocVersion(ctx.prisma, {
        documentId: input.docId,
        userId: ctx.user.id,
        version: input.version,
      }),
    ),

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

  /**
   * «Опубликовать как страницу» of a `.html` or `.md` of the chat (Ст32): where it goes is the
   * client's — a new page, or the next version of a page at the version they saw (Дер9).
   */
  publishFile: consentedProcedure
    .input(
      z.strictObject({
        taskId: z.uuid(),
        fileId: z.uuid(),
        target: z.union([
          z.strictObject({ new: z.strictObject({ title: pageTitleSchema.optional() }) }),
          z.strictObject({ pageId: z.uuid(), expectedVersion: z.number().int().min(0) }),
        ]),
      }),
    )
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

  /** «Удалить»: to the trash for 30 days; the address answers 410 at once (Дер2). */
  delete: consentedProcedure
    .input(pageInput)
    .output(z.strictObject({ purgeAfter: z.iso.datetime() }))
    .mutation(({ ctx, input }) => deleteCabinetPage(ctx.prisma, { ...input, userId: ctx.user.id })),

  /**
   * Renames, readdresses, moves or reorders a page of a site, at once (docs/plan/73-pages-sites.md,
   * Дер30); the home page keeps its address.
   */
  update: consentedProcedure
    .input(
      pageInput
        .extend({
          title: pageTitleSchema.optional(),
          segment: pageSegmentSchema.optional(),
          parentId: z.uuid().optional(),
          position: z.number().int().min(0).max(1000).optional(),
        })
        .refine(
          (input) =>
            input.title !== undefined ||
            input.segment !== undefined ||
            input.parentId !== undefined ||
            input.position !== undefined,
          'say what changes',
        ),
    )
    .output(z.strictObject({ path: pagePathSchema }))
    .mutation(({ ctx, input }) => updateCabinetPage(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** «Файлы сайта»: the shared files of the site of a page (Дер34). */
  files: consentedProcedure
    .input(pageInput)
    .output(
      z.array(
        z.strictObject({
          path: pageFilePathSchema,
          type: z.string(),
          sizeBytes: z.number().int().min(0),
          updatedAt: z.iso.datetime(),
        }),
      ),
    )
    .query(({ ctx, input }) => cabinetSiteFiles(ctx.prisma, { ...input, userId: ctx.user.id })),

  deleteFile: consentedProcedure
    .input(pageInput.extend({ path: pageFilePathSchema }))
    .mutation(({ ctx, input }) =>
      deleteCabinetSiteFile(ctx.prisma, { ...input, userId: ctx.user.id }),
    ),

  /** «Адрес сайта…»: its own name, on «Бизнес» and above (Дер32). */
  setName: consentedProcedure
    .input(pageInput.extend({ name: z.string().min(1).max(40) }))
    .output(z.strictObject({ name: pageNameSchema }))
    .mutation(({ ctx, input }) => nameCabinetSite(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** «Вернуть» from the trash: the same address and version. */
  returnDeleted: consentedProcedure
    .input(pageInput)
    .mutation(({ ctx, input }) => returnCabinetPage(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** «Удалить навсегда»: a page in the trash, at once. */
  purge: consentedProcedure
    .input(pageInput)
    .mutation(({ ctx, input }) => purgeCabinetPage(ctx.prisma, { ...input, userId: ctx.user.id })),
})

/** The address of the pages here; none — publications are off (PAGES_BASE_DOMAIN unset). */
function pagesAddressOf(ctx: { chat?: { pages?: PagesAddress | null } | null }): PagesAddress {
  const address = ctx.chat?.pages ?? null
  if (address === null) throw new DomainError('PAGES_OFF', 'Pages are not set up here', 409)
  return address
}
