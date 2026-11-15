import {
  memoryForgetArgumentsSchema,
  memoryKinds,
  memoryLimits,
  memoryListArgumentsSchema,
  memorySaveArgumentsSchema,
  memoryUpdateArgumentsSchema,
} from '@repo/domain'
import { z } from 'zod'

/**
 * The tools of the memory as the model sees them (docs/plan/84-projects.md, §4.4): the domain's
 * own schemas with words for the model. The request policy checks the domain's.
 */
const text = z
  .string()
  .trim()
  .min(1)
  .max(memoryLimits.textChars)
  .describe('The note in Russian, short and neutral: one preference, fact, decision or reference')
const id = z.uuid().describe('An entry of memory_list or of the section «Memory»')
const version = z
  .number()
  .int()
  .min(1)
  .describe('The version memory_list gave you; another one since — nothing changes')

export const memoryListToolArgumentsSchema = z.strictObject({})
export const memorySaveToolArgumentsSchema = z.strictObject({
  kind: z
    .enum(memoryKinds)
    .describe(
      'preference — how the client likes things; fact; decision; reference — where to look',
    ),
  text,
})
export const memoryUpdateToolArgumentsSchema = z.strictObject({
  id,
  text,
  expectedVersion: version,
})
export const memoryForgetToolArgumentsSchema = z.strictObject({ id, expectedVersion: version })

// The domain's own rules, for the body check of the role (mcp-policy).
export {
  memoryForgetArgumentsSchema,
  memoryListArgumentsSchema,
  memorySaveArgumentsSchema,
  memoryUpdateArgumentsSchema,
}
