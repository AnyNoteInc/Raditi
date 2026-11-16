import {
  projectFileIdSchema,
  projectFileIdsSchema,
  projectFileStartInputSchema,
  projectTextInputSchema,
} from '@repo/domain'
import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import { WRITE } from '../services/chat/dialog-lock.ts'
import {
  addProjectText,
  bindFilesToProject,
  listFilesOfProject,
  removeFileOfProject,
  startProjectFile,
} from '../services/projects/files.ts'
import { consentedProcedure, router } from '../trpc.ts'

// The files and texts of the context of a project (docs/plan/84-projects.md, ПР8, §4.4; slice
// 84.8). The bytes go to web (`PUT /api/project-files/<id>`), never through tRPC; a project takes
// the files at its creation (`project.create({ fileIds })`) or later (`bind`). Only the author of
// the project sees them; a file no project took, only its uploader.

const projectRef = z.uuid().transform((id) => id.toLowerCase())

const fileItem = z.strictObject({
  id: z.uuid(),
  projectId: z.uuid().nullable(),
  kind: z.enum(['file', 'text']),
  /** The path in /workspace/project: «Фото/витрина.jpg». */
  name: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(['uploading', 'ready']),
  createdAt: z.date(),
})

export const projectFileRouter = router({
  /**
   * Announces a file of the context: its name — or its path in a folder («Фото/витрина.jpg») — as
   * the browser gave it, its size and the type of its extension. `projectId` — the project it is
   * meant for: its room is checked now. Answers the id, the clean path and where the bytes go; a
   * file the rules refuse answers why (PROJECT_FILE_REFUSED), a full room — PROJECT_SPACE_FULL or
   * PROJECT_FILES_TOO_MANY.
   */
  start: consentedProcedure
    .input(projectFileStartInputSchema.extend({ projectId: projectRef.optional() }))
    .output(z.strictObject({ fileId: z.uuid(), name: z.string(), uploadPath: z.string() }))
    .mutation(({ ctx, input }) =>
      startProjectFile(ctx.prisma, {
        userId: ctx.user.id,
        appEnv: chatContextOf(ctx).appEnv,
        projectId: input.projectId ?? null,
        name: input.name,
        size: input.size,
        type: input.type,
      }),
    ),

  /**
   * «Добавить текстовое содержимое»: a title and up to 100 000 characters, kept as a `.md` file;
   * with `projectId` the project takes it at once. A text like a password or a key is refused
   * (PROJECT_TEXT_HAS_SECRET).
   */
  addText: consentedProcedure
    .input(projectTextInputSchema.extend({ projectId: projectRef.optional() }))
    .output(z.strictObject({ fileId: z.uuid(), name: z.string() }))
    .mutation(({ ctx, input }) =>
      addProjectText(ctx.prisma, chatContextOf(ctx).storage, {
        userId: ctx.user.id,
        appEnv: chatContextOf(ctx).appEnv,
        projectId: input.projectId ?? null,
        title: input.title,
        text: input.text,
      }),
    ),

  /** Files uploaded for an existing project are taken by it: all of them or none. */
  bind: consentedProcedure
    .input(z.strictObject({ projectId: projectRef, fileIds: projectFileIdsSchema.min(1) }))
    .output(z.strictObject({ bound: z.number().int() }))
    .mutation(({ ctx, input }) =>
      ctx.prisma.$transaction(
        (tx) =>
          bindFilesToProject(tx, {
            projectId: input.projectId,
            userId: ctx.user.id,
            fileIds: input.fileIds,
          }),
        WRITE,
      ),
    ),

  /** «Контекст»: the files of the project, by path, and the room they take. */
  list: consentedProcedure
    .input(z.strictObject({ projectId: projectRef }))
    .output(
      z.strictObject({
        files: z.array(fileItem),
        bytes: z.number().int(),
        limitBytes: z.number().int(),
        percent: z.number().int(),
      }),
    )
    .query(({ ctx, input }) =>
      listFilesOfProject(ctx.prisma, { userId: ctx.user.id, projectId: input.projectId }),
    ),

  /**
   * Removes a file of the project — or, with `projectId: null`, one of the user's no project took
   * yet (the window of a new project).
   */
  remove: consentedProcedure
    .input(z.strictObject({ projectId: projectRef.nullable(), fileId: projectFileIdSchema }))
    .output(z.strictObject({ fileId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await removeFileOfProject(ctx.prisma, chatContextOf(ctx).storage, {
        userId: ctx.user.id,
        projectId: input.projectId,
        fileId: input.fileId,
      })
      return { fileId: input.fileId }
    }),
})
