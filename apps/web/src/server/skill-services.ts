import 'server-only'

import { repoReaders, SkillSources } from '@repo/skill-sources'
import type { AccountSkillServices } from '@repo/trpc'

import { chatServices } from '@/server/chat-services'

let sources: SkillSources | undefined

/**
 * What the skills of an account are installed through (docs/plan/97-skills.md): the readers of
 * public repositories of GitHub and gitlab.com, and the store of chats — a skill's files live in
 * the same bucket as the files of chats. null while the chat services do not parse: skills are
 * listed and switched, but nothing is installed or opened.
 */
export function skillServices(): AccountSkillServices | null {
  const chat = chatServices()
  if (chat === null) return null
  sources ??= new SkillSources(repoReaders())
  return { sources, storage: chat.storage }
}
