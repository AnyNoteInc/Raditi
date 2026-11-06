import { z } from 'zod'

// What a task's environment needs (docs/plan/57-browser-tasks.md, Б2–Б4). The two needs are
// independent: a repository is the site's git checkout — base bundle, diff capture, candidate and
// publication of the task branch; a browser is a session of the platform's cloud browser the
// agent drives through its MCP tools, outside the sandbox. Every layer branches on each flag on
// its own. Every combination is a task: both together are a chat with a project, neither is a
// chat without a project and without the browser (docs/plan/61-chats-first.md, §1, К10).

export const taskRequirementsSchema = z.strictObject({
  repository: z.boolean(),
  browser: z.boolean(),
})
export type TaskRequirements = z.infer<typeof taskRequirementsSchema>

/** A task with a site needs something (`tasks_requirements_check`); only a chat may need nothing. */
export const siteTaskRequirementsSchema = taskRequirementsSchema.refine(
  (r) => r.repository || r.browser,
  'a task with a site needs a repository, a browser or both',
)

/** Every task and turn plan written before the requirements: the site's repository only. */
export const REPOSITORY_ONLY: TaskRequirements = Object.freeze({ repository: true, browser: false })
/** A task done in the cloud browser alone: no clone, no candidate, no publication (Б4). */
export const BROWSER_ONLY: TaskRequirements = Object.freeze({ repository: false, browser: true })
/** A chat that needs neither: no project and no browser configured (plan 61, §1). */
export const PLAIN_CHAT: TaskRequirements = Object.freeze({ repository: false, browser: false })

/** The requirements of a plan; one without the field is older than them: a repository task. */
export const requirementsOf = (plan: { requirements?: TaskRequirements }): TaskRequirements =>
  plan.requirements ?? REPOSITORY_ONLY
