import { z } from 'zod'

import { chatCommandIds, chatCommands } from '../chat/chat-commands.ts'
import { accountSkillLimits } from './limits.ts'

// The name of a skill (docs/plan/97-skills.md, Нв15, Нв18): the rule of the open standard
// (agentskills.io) — `[a-z0-9-]`, 1–64, no hyphen at either end, no `--`, the name of its folder.
// The name is what the client types after `/`, and the folder under SANDBOX_SKILLS.

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const skillNameSchema = z
  .string()
  .min(1)
  .max(accountSkillLimits.nameChars)
  .regex(NAME, 'expected a name of lowercase letters, digits and single hyphens')

export const isSkillName = (value: string): boolean => skillNameSchema.safeParse(value).success

/**
 * Names a skill of an account may not take: the commands of a chat (they come first, the agent
 * never sees them), the commands of the Telegram bot, the commands of sites before plan 83 that
 * old feeds still name, and OpenCode's own `customize-opencode`. The built-in skills are reserved
 * by `builtinSkillNames` besides.
 */
const telegramCommands = ['start', 'stop', 'help', 'new', 'delete', 'chats', 'usage', 'status']
const historicCommands = ['release', 'preview', 'update', 'reset', 'rollback', 'init', 'retry']
const cliSkills = ['customize-opencode']

export const reservedSkillNames: ReadonlySet<string> = new Set([
  ...chatCommandIds.flatMap((id) =>
    [chatCommands[id].slash, ...(chatCommands[id].aliases ?? [])].map((slash) => slash.slice(1)),
  ),
  ...telegramCommands,
  ...historicCommands,
  ...cliSkills,
  'skill',
  'skills',
])

export const isReservedSkillName = (name: string): boolean => reservedSkillNames.has(name)
