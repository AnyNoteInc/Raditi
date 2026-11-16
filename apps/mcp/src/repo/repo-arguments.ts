import { repoRequestMergeArgumentsSchema, repoStatusArgumentsSchema } from '@repo/domain'
import { z } from 'zod'

/**
 * The tools of the repository as the model sees them (docs/plan/84-projects.md, §4.4): the domain's
 * own schemas with words for the model. The request policy checks the domain's.
 */
export const repoStatusToolArgumentsSchema = z.strictObject({})
export const repoRequestMergeToolArgumentsSchema = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe('The title of the merge request in Russian: what the change does, in a few words'),
  description: z
    .string()
    .max(4000)
    .describe('What changed and why, in Russian, for the people who review it; no secrets'),
  draft: z.boolean().optional().describe('true — open it as a draft, not ready to be accepted'),
})

// The domain's own rules, for the body check of the role (mcp-policy).
export { repoRequestMergeArgumentsSchema, repoStatusArgumentsSchema }
