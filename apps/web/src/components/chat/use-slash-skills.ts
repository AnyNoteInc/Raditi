'use client'

import { useQuery } from '@tanstack/react-query'

import { useTRPC } from '@/trpc/client'

import type { SlashSkill } from './command-palette'

const NONE: readonly SlashSkill[] = []

/**
 * The enabled skills of the account for the window of commands (docs/plan/97-skills.md, Нв18):
 * read once a minute at most; none while they are not read, or when they cannot be.
 */
export function useSlashSkills(): readonly SlashSkill[] {
  const trpc = useTRPC()
  const skills = useQuery({ ...trpc.accountSkills.slashNames.queryOptions(), staleTime: 60_000 })
  return skills.data ?? NONE
}
