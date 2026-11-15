import {
  addMemoryEntry,
  clearMemory,
  confirmMemoryEntry,
  editMemoryEntry,
  findPersonalWorkspace,
  listMemory,
  readMemoryEntry,
  readProject,
  rejectMemoryEntry,
  removeMemoryEntry,
  type MemoryScope,
  type PrismaClient,
} from '@repo/db'
import { memoryKindSchema, memoryLimits, type AppEnv } from '@repo/domain'
import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import { personalWorkspaceOf } from '../services/chat/dialog-lock.ts'
import { consentedProcedure, router } from '../trpc.ts'

// «Память» of a project and of the account (docs/plan/84-projects.md, ПР18, ПР28, §4.4; slice
// 84.13). `projectId` names the memory of a project of the user; null — the account's, of their
// chats without a project. Only the owner sees and changes it; anything else answers
// MEMORY_NOT_FOUND or PROJECT_NOT_FOUND, as what does not exist.

const projectRef = z.uuid().transform((id) => id.toLowerCase())
const entryRef = z.uuid().transform((id) => id.toLowerCase())
const version = z.number().int().min(1).max(1_000_000)
/** The text as the client typed it: the domain trims it and says why it is refused. */
const textInput = z.string().max(memoryLimits.textChars * 2)

const memoryRow = z.strictObject({
  id: z.uuid(),
  kind: memoryKindSchema,
  text: z.string(),
  status: z.enum(['active', 'proposed']),
  author: z.enum(['agent', 'client']),
  version: z.number().int(),
  pendingAction: z.enum(['update', 'forget']).nullable(),
  pendingText: z.string().nullable(),
  source: z.strictObject({ taskId: z.uuid(), title: z.string().nullable() }).nullable(),
  confirmed: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

/** The memory `projectId` names, for reading: null — the account has no workspace yet. */
async function scopeToRead(
  db: PrismaClient,
  user: { userId: string; appEnv: AppEnv },
  projectId: string | null,
): Promise<{ scope: MemoryScope | null; useAccountMemory: boolean | null }> {
  if (projectId !== null) {
    const project = await readProject(db, { projectId, userId: user.userId })
    return {
      scope: { workspaceId: project.workspaceId, userId: user.userId, projectId: project.id },
      useAccountMemory: project.useAccountMemory,
    }
  }
  const workspace = await findPersonalWorkspace(db, user)
  return {
    scope: workspace ? { workspaceId: workspace.id, userId: user.userId, projectId: null } : null,
    useAccountMemory: null,
  }
}

/** The memory `projectId` names, for writing: the account's comes with the personal workspace. */
async function scopeToWrite(
  db: PrismaClient,
  user: { userId: string; appEnv: AppEnv },
  projectId: string | null,
): Promise<MemoryScope> {
  const read = await scopeToRead(db, user, projectId)
  if (read.scope) return read.scope
  const workspace = await personalWorkspaceOf(db, user)
  return { workspaceId: workspace.id, userId: user.userId, projectId: null }
}

export const projectMemoryRouter = router({
  /**
   * The entries of one memory, newest first, and its switches: «Использовать память аккаунта» of
   * a project and «Агент запоминает важное» of the user.
   */
  list: consentedProcedure
    .input(z.strictObject({ projectId: projectRef.nullable() }))
    .output(
      z.strictObject({
        entries: z.array(memoryRow),
        useAccountMemory: z.boolean().nullable(),
        agentMemory: z.boolean(),
        limit: z.number().int(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const user = { userId: ctx.user.id, appEnv: chatContextOf(ctx).appEnv }
      const [read, row] = await Promise.all([
        scopeToRead(ctx.prisma, user, input.projectId),
        ctx.prisma.user.findUniqueOrThrow({
          where: { id: ctx.user.id },
          select: { agentMemory: true },
        }),
      ])
      return {
        entries: read.scope ? await listMemory(ctx.prisma, read.scope) : [],
        useAccountMemory: read.useAccountMemory,
        agentMemory: row.agentMemory,
        limit: memoryLimits.entries,
      }
    }),

  /** One entry, for a row of the chat that offers «Сохранить» and «Не надо»; null — gone. */
  get: consentedProcedure
    .input(z.strictObject({ id: entryRef }))
    .output(memoryRow.nullable())
    .query(({ ctx, input }) =>
      readMemoryEntry(ctx.prisma, { userId: ctx.user.id, entryId: input.id }),
    ),

  /** «Добавить запись»: active at once (MEMORY_LIMIT at 40, MEMORY_HAS_SECRET, MEMORY_TEXT_INVALID). */
  add: consentedProcedure
    .input(
      z.strictObject({ projectId: projectRef.nullable(), kind: memoryKindSchema, text: textInput }),
    )
    .output(memoryRow)
    .mutation(async ({ ctx, input }) => {
      const scope = await scopeToWrite(
        ctx.prisma,
        { userId: ctx.user.id, appEnv: chatContextOf(ctx).appEnv },
        input.projectId,
      )
      return addMemoryEntry(ctx.prisma, { scope, kind: input.kind, text: input.text })
    }),

  /** «Изменить»: at the version shown (MEMORY_VERSION_CHANGED otherwise). */
  update: consentedProcedure
    .input(
      z.strictObject({
        id: entryRef,
        text: textInput,
        kind: memoryKindSchema.optional(),
        expectedVersion: version,
      }),
    )
    .output(memoryRow)
    .mutation(({ ctx, input }) =>
      editMemoryEntry(ctx.prisma, {
        userId: ctx.user.id,
        entryId: input.id,
        text: input.text,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        expectedVersion: input.expectedVersion,
      }),
    ),

  /** «Сохранить» of a proposal of the agent, at the version shown. */
  confirm: consentedProcedure
    .input(z.strictObject({ id: entryRef, expectedVersion: version }))
    .output(
      z.strictObject({
        decision: z.enum(['saved', 'updated', 'forgotten', 'dropped']),
        entry: memoryRow.nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      confirmMemoryEntry(ctx.prisma, {
        userId: ctx.user.id,
        entryId: input.id,
        expectedVersion: input.expectedVersion,
      }),
    ),

  /** «Не надо»: the proposal goes, an active entry keeps its text. */
  reject: consentedProcedure
    .input(z.strictObject({ id: entryRef, expectedVersion: version }))
    .output(z.strictObject({ decision: z.literal('dropped'), entry: memoryRow.nullable() }))
    .mutation(({ ctx, input }) =>
      rejectMemoryEntry(ctx.prisma, {
        userId: ctx.user.id,
        entryId: input.id,
        expectedVersion: input.expectedVersion,
      }),
    ),

  /** «Удалить»: forever (ПР28). */
  remove: consentedProcedure
    .input(z.strictObject({ id: entryRef }))
    .output(z.strictObject({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await removeMemoryEntry(ctx.prisma, { userId: ctx.user.id, entryId: input.id })
      return { id: input.id }
    }),

  /** «Очистить память»: every entry of the project, or of the account (ПР28). */
  clear: consentedProcedure
    .input(z.strictObject({ projectId: projectRef.nullable() }))
    .output(z.strictObject({ removed: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const read = await scopeToRead(
        ctx.prisma,
        { userId: ctx.user.id, appEnv: chatContextOf(ctx).appEnv },
        input.projectId,
      )
      return read.scope ? clearMemory(ctx.prisma, { scope: read.scope }) : { removed: 0 }
    }),
})
