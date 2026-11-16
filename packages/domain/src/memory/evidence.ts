import type { AgentEvent } from '../ports/agent-driver.ts'

// What a pass took in from outside, by its events (docs/plan/84-projects.md, ПР18): a tool that
// brings text of the web, of a skill or of a log, and every command of the shell (`cat` of a file,
// `curl`). Read by the common events alone (rule 8), so every driver gives the same answer.

/**
 * The tools that bring nothing from outside: the memory itself, the facts of the platform, the
 * pages and documents of the workspace, and the built-in tools of the agent over its own folders.
 * Any other — `web_*`, `webfetch`, `websearch`, `search_web`, a tool of a skill, `repo_job_log`, a
 * sub-agent, a tool this list does not know — counts as outside.
 */
const inside = new Set([
  'memory_list',
  'memory_save',
  'memory_update',
  'memory_forget',
  'site_info',
  'read',
  'write',
  'edit',
  'patch',
  'multiedit',
  'glob',
  'grep',
  'list',
  'ls',
  'todoread',
  'todowrite',
])
const insideFamilies = /^(?:page|doc)_[a-z_]+$/
/**
 * What a page or a document holds may have come from the web in another chat (ревью,
 * безопасность 3): reading one counts as outside.
 */
const readsContent = /^(?:page|doc)_read$/

const isInside = (tool: string) =>
  inside.has(tool) || (insideFamilies.test(tool) && !readsContent.test(tool))

export interface MemoryPassEvidence {
  /** A tool that brings text from outside ran. */
  outside: boolean
  /** A command of the shell ran. */
  commands: boolean
}

export function memoryPassEvidence(events: readonly AgentEvent[]): MemoryPassEvidence {
  let outside = false
  let commands = false
  for (const event of events) {
    if (event.type === 'command') commands = true
    if (event.type === 'tool_call' && !isInside(event.tool.replace(/^raditi_/, ''))) outside = true
  }
  return { outside, commands }
}
