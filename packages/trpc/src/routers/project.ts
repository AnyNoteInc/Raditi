import {
  archiveProject,
  createProject,
  listProjects,
  readProject,
  restoreProject,
  setProjectInstructions,
  starProject,
  trashProject,
  updateProject,
} from '@repo/db'
import {
  projectGoalInputSchema,
  projectGoalOf,
  projectIdSchema,
  projectInstructionsInputSchema,
  projectInstructionsOf,
  projectListSortSchema,
  projectListViewSchema,
  projectNameInputSchema,
  projectNameOf,
} from '@repo/domain'
import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import { personalWorkspaceOf, WRITE } from '../services/chat/dialog-lock.ts'
import { consentedProcedure, router } from '../trpc.ts'

// «Проекты» (docs/plan/84-projects.md, §4.4; slice 84.4): the projects of the user, in their
// personal workspace (ПР1). Only the author sees and changes a project: any other answers
// PROJECT_NOT_FOUND, as one that does not exist. The context, the memory, the repository and the
// tasks of a project come with their own slices.

/** A project that exists answers by its id as PostgreSQL prints it. */
const projectRef = z.uuid().transform((id) => id.toLowerCase())

const projectListItem = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  goal: z.string().nullable(),
  starred: z.boolean(),
  archived: z.boolean(),
  /** Its chats that are shown. */
  chats: z.number().int().min(0),
  /** The menu of the field names what the agent will take (ПР30). */
  hasInstructions: z.boolean(),
  activityAt: z.date(),
  createdAt: z.date(),
  /** In «Корзина»: when it is purged (ПР20); null elsewhere. */
  purgeAfter: z.date().nullable(),
})

const projectOutput = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  goal: z.string().nullable(),
  instructions: z.string().nullable(),
  useAccountMemory: z.boolean(),
  starred: z.boolean(),
  archived: z.boolean(),
  chats: z.number().int().min(0),
  activityAt: z.date(),
  createdAt: z.date(),
})

export const projectRouter = router({
  /**
   * The projects of a tab of «Проекты» (ПР4): «Все» by default, the latest activity first; `query`
   * finds the words in the name or the goal.
   */
  list: consentedProcedure
    .input(
      z
        .strictObject({
          view: projectListViewSchema.optional(),
          sort: projectListSortSchema.optional(),
          query: z.string().max(100).optional(),
        })
        .optional(),
    )
    .output(z.strictObject({ items: z.array(projectListItem) }))
    .query(async ({ ctx, input }) => ({
      items: await listProjects(ctx.prisma, { userId: ctx.user.id, ...input }),
    })),

  /** One project for its page. */
  get: consentedProcedure
    .input(z.strictObject({ projectId: projectRef }))
    .output(projectOutput)
    .query(async ({ ctx, input }) => {
      const { workspaceId: _workspace, ...project } = await readProject(ctx.prisma, {
        projectId: input.projectId,
        userId: ctx.user.id,
      })
      return project
    }),

  /**
   * «Создать проект» (ПР5): the id comes from the browser, and a repeat returns the same project.
   * It goes to the personal workspace of the user, made here with the gift of the registration
   * for a new user, as for a first chat (К15).
   */
  create: consentedProcedure
    .input(
      z.strictObject({
        projectId: projectIdSchema,
        name: projectNameInputSchema,
        goal: projectGoalInputSchema.optional(),
      }),
    )
    .output(z.strictObject({ projectId: z.uuid(), created: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const name = projectNameOf(input.name)
      const goal = projectGoalOf(input.goal)
      const { id: workspaceId } = await personalWorkspaceOf(ctx.prisma, {
        userId: ctx.user.id,
        appEnv: chatContextOf(ctx).appEnv,
      })
      return ctx.prisma.$transaction(
        (tx) =>
          createProject(tx, {
            id: input.projectId,
            workspaceId,
            userId: ctx.user.id,
            name,
            goal,
            now: new Date(),
          }),
        WRITE,
      )
    }),

  /** «Переименовать», the goal and «Память аккаунта» (ПР5, ПР18). */
  update: consentedProcedure
    .input(
      z.strictObject({
        projectId: projectRef,
        name: projectNameInputSchema.optional(),
        /** '' — no goal. */
        goal: projectGoalInputSchema.optional(),
        useAccountMemory: z.boolean().optional(),
      }),
    )
    .output(z.strictObject({ updated: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await updateProject(ctx.prisma, {
        projectId: input.projectId,
        userId: ctx.user.id,
        ...(input.name === undefined ? {} : { name: projectNameOf(input.name) }),
        ...(input.goal === undefined ? {} : { goal: projectGoalOf(input.goal) }),
        ...(input.useAccountMemory === undefined
          ? {}
          : { useAccountMemory: input.useAccountMemory }),
        now: new Date(),
      })
      return { updated: true as const }
    }),

  /**
   * The instructions of the project (ПР7): up to 8000 characters, nothing like a password or a
   * key; '' takes them away. They reach the agent from slice 84.7.
   */
  setInstructions: consentedProcedure
    .input(z.strictObject({ projectId: projectRef, text: projectInstructionsInputSchema }))
    .output(z.strictObject({ text: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const instructions = projectInstructionsOf(input.text)
      await setProjectInstructions(ctx.prisma, {
        projectId: input.projectId,
        userId: ctx.user.id,
        instructions,
        now: new Date(),
      })
      return { text: instructions ?? '' }
    }),

  /** «В избранное» / «Убрать из избранного». */
  star: consentedProcedure
    .input(z.strictObject({ projectId: projectRef, starred: z.boolean() }))
    .output(z.strictObject({ starred: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await starProject(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() })
      return { starred: input.starred }
    }),

  /** «В архив» / «Из архива» (ПР20): a new chat does not start in a project in «Архив». */
  archive: consentedProcedure
    .input(z.strictObject({ projectId: projectRef, archived: z.boolean() }))
    .output(z.strictObject({ archived: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await archiveProject(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() })
      return { archived: input.archived }
    }),

  /**
   * «Удалить» (ПР20): into the trash for 30 days with its chats, which the cabinet no longer shows.
   * A pass queued or running there is stopped in the same transaction, and core purges the project
   * after its day (slice 84.5).
   */
  remove: consentedProcedure
    .input(z.strictObject({ projectId: projectRef }))
    .output(z.strictObject({ purgeAfter: z.date() }))
    .mutation(({ ctx, input }) =>
      trashProject(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
    ),

  /** «Вернуть» from the trash, until the day it is purged (ПР20). */
  restore: consentedProcedure
    .input(z.strictObject({ projectId: projectRef }))
    .output(z.strictObject({ restored: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await restoreProject(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() })
      return { restored: true as const }
    }),
})
