import { z } from 'zod'

// What a task's environment needs (docs/plan/57-browser-tasks.md, Б2–Б4). The two needs are
// independent: a repository is the site's git checkout — base bundle, diff capture, candidate and
// publication of the task branch; a browser is a session of the platform's cloud browser the
// agent drives through its MCP tools, outside the sandbox. Every layer branches on each flag on
// its own. The schemas express both together; the product accepts `{repository}` and `{browser}`
// for now (Б3).

export const taskRequirementsSchema = z
  .strictObject({
    repository: z.boolean(),
    browser: z.boolean(),
  })
  .refine((r) => r.repository || r.browser, 'a task needs a repository, a browser or both')
export type TaskRequirements = z.infer<typeof taskRequirementsSchema>

/** Every task and turn plan written before the requirements: the site's repository only. */
export const REPOSITORY_ONLY: TaskRequirements = Object.freeze({ repository: true, browser: false })
/** A task done in the cloud browser alone: no clone, no candidate, no publication (Б4). */
export const BROWSER_ONLY: TaskRequirements = Object.freeze({ repository: false, browser: true })

/** The requirements of a plan; one without the field is older than them: a repository task. */
export const requirementsOf = (plan: { requirements?: TaskRequirements }): TaskRequirements =>
  plan.requirements ?? REPOSITORY_ONLY
