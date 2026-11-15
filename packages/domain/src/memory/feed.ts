import { z } from 'zod'

import { memoryChangeKinds, memoryKindSchema, memoryTextSchema } from './schemas.ts'

// The feed rows of the memory (docs/plan/84-projects.md, ПР18, §4.4): what the end of a pass did
// with the notes the agent reserved — «Запомнено: …», «Агент предлагает запомнить: …» — and a note
// it did not keep. A refused note is told without its text: it may be a secret.

/** What came of a change of the agent. */
export const memoryChangeActions = [
  'saved',
  'proposed',
  'updated',
  'update_proposed',
  'forgotten',
  'forget_proposed',
] as const
export type MemoryChangeAction = (typeof memoryChangeActions)[number]

/** `feed.memory_change` v1. */
export const feedMemoryChangePayloadSchema = z.strictObject({
  v: z.literal(1),
  action: z.enum(memoryChangeActions),
  entryId: z.uuid(),
  kind: memoryKindSchema,
  text: memoryTextSchema,
})
export type FeedMemoryChangePayload = z.infer<typeof feedMemoryChangePayloadSchema>

/**
 * Why a change was not kept: `secret` — the text looks like a password, a key, a key of the turn
 * or a value of a variable; `limit` — the memory is full; `version` — the entry changed meanwhile;
 * `not_found` — the entry is gone, or the chat left its memory; `off` — the client turned the
 * memory off; `failed` — the platform lost it.
 */
export const memoryLeftReasons = [
  'secret',
  'limit',
  'version',
  'not_found',
  'off',
  'failed',
] as const
export type MemoryLeftReason = (typeof memoryLeftReasons)[number]

/** `feed.memory_left` v1. */
export const feedMemoryLeftPayloadSchema = z.strictObject({
  v: z.literal(1),
  action: z.enum(memoryChangeKinds),
  reason: z.enum(memoryLeftReasons),
})
export type FeedMemoryLeftPayload = z.infer<typeof feedMemoryLeftPayloadSchema>
