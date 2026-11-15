import { z } from 'zod'

import { memoryLimits } from './limits.ts'

// The words of the memory of an account and of its projects (docs/plan/84-projects.md, ПР18, §4.1,
// §4.4): an entry is a short note — a preference, a fact, a decision or a reference — of the client
// or of the agent; `proposed` waits for the client, only `active` goes to the agent.

export const memoryKinds = ['preference', 'fact', 'decision', 'reference'] as const
export type MemoryKind = (typeof memoryKinds)[number]
export const memoryKindSchema = z.enum(memoryKinds)

export const memoryStatuses = ['active', 'proposed'] as const
export type MemoryStatus = (typeof memoryStatuses)[number]

export const memoryAuthors = ['agent', 'client'] as const
export type MemoryAuthor = (typeof memoryAuthors)[number]

/** A proposal of the agent over an active entry: its new text, or to forget it (ПР18). */
export const memoryPendingActions = ['update', 'forget'] as const
export type MemoryPendingAction = (typeof memoryPendingActions)[number]

/** The three changes the agent reserves in a turn (`memory_reservations.kind`). */
export const memoryChangeKinds = ['save', 'update', 'forget'] as const
export type MemoryChangeKind = (typeof memoryChangeKinds)[number]

/** The text of an entry: 1 to 400 characters after trimming. */
export const memoryTextSchema = z.string().trim().min(1).max(memoryLimits.textChars)

const version = z.number().int().min(1).max(1_000_000)

export const memoryListArgumentsSchema = z.strictObject({})
export const memorySaveArgumentsSchema = z.strictObject({
  kind: memoryKindSchema,
  text: memoryTextSchema,
})
export const memoryUpdateArgumentsSchema = z.strictObject({
  id: z.uuid(),
  text: memoryTextSchema,
  expectedVersion: version,
})
export const memoryForgetArgumentsSchema = z.strictObject({
  id: z.uuid(),
  expectedVersion: version,
})
export type MemorySaveArguments = z.infer<typeof memorySaveArgumentsSchema>
export type MemoryUpdateArguments = z.infer<typeof memoryUpdateArgumentsSchema>
export type MemoryForgetArguments = z.infer<typeof memoryForgetArgumentsSchema>

/**
 * What a reservation keeps (`memory_reservations.payload`): the arguments of its tool and the
 * memory it was asked in — the project of the chat, or none for the account's — so that the end of
 * the turn applies it to the memory the agent saw, and refuses it if the chat moved meanwhile.
 */
export const memoryReservationPayloadSchema = z.strictObject({
  projectId: z.uuid().nullable(),
  kind: memoryKindSchema.optional(),
  text: memoryTextSchema.optional(),
  expectedVersion: version.optional(),
})
export type MemoryReservationPayload = z.infer<typeof memoryReservationPayloadSchema>

/** A change as the agent asked it, before it is reserved. */
export type MemoryChangeRequest =
  | { kind: 'save'; entryKind: MemoryKind; text: string }
  | { kind: 'update'; entryId: string; text: string; expectedVersion: number }
  | { kind: 'forget'; entryId: string; expectedVersion: number }
