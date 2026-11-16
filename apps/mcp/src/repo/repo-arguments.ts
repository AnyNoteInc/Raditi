import {
  repoJobLogArgumentsSchema,
  repoRequestMergeArgumentsSchema,
  repoRunsArgumentsSchema,
  repoStatusArgumentsSchema,
} from '@repo/domain'
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

export const repoRunsToolArgumentsSchema = z.strictObject({
  branch: z
    .enum(['chat', 'default'])
    .optional()
    .describe("'chat' — builds of the chat's branch, 'default' — of the main branch; none — both"),
  limit: z.number().int().min(1).max(10).optional().describe('How many of the newest, 1 to 10'),
})
export const repoJobLogToolArgumentsSchema = z.strictObject({
  runId: z.string().min(1).max(40).describe('The id of the build, as repo_runs gives it'),
  jobId: z.string().min(1).max(40).describe('The id of one of its jobs, as repo_runs gives it'),
  tailBytes: z
    .number()
    .int()
    .min(1024)
    .max(32768)
    .optional()
    .describe('How much of the end of the log, 1024 to 32768 bytes; 32768 by default'),
})

// The domain's own rules, for the body check of the role (mcp-policy).
export {
  repoJobLogArgumentsSchema,
  repoRequestMergeArgumentsSchema,
  repoRunsArgumentsSchema,
  repoStatusArgumentsSchema,
}
