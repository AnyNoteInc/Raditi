import { z } from 'zod'

import { projectLimits } from './limits.ts'

/** The id of a project: a UUID of version 7 the browser made (ПР1), as PostgreSQL prints it. */
export const projectIdSchema = z.uuid({ version: 'v7' }).transform((id) => id.toLowerCase())

/**
 * Bounds of the bodies of the procedures: the lengths the project keeps are checked after trimming,
 * in the client's words (`projectNameOf`, `projectGoalOf`, `projectInstructionsOf`).
 */
export const projectNameInputSchema = z.string().max(projectLimits.nameChars * 4)
export const projectGoalInputSchema = z.string().max(projectLimits.goalChars * 4)
export const projectInstructionsInputSchema = z.string().max(projectLimits.instructionsChars * 2)

/** The project a chat is in, as its head and the rows of the list tell it (ПР2). */
export const chatProjectSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().max(projectLimits.nameChars),
})
export type ChatProject = z.infer<typeof chatProjectSchema>
