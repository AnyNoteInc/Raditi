'use client'

import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'

import type { ComposerMentions } from '@/components/chat/composer'
import { useTRPC } from '@/trpc/client'

import { contextText } from './project-texts'

/**
 * Where the files of the context lie for the agent in every turn (ПР8): `SANDBOX_PROJECT` of the
 * domain and a slash — a test holds the two together; the root of `@repo/domain` is not for pages.
 */
export const CONTEXT_MENTION_ROOT = '/workspace/project/'

/**
 * `@` in a chat of a project names the files of its context (docs/plan/84-projects.md, ПР24): the
 * dormant hook of plan 78 (`ComposerMentions`). The list is read when `@` is first typed, not
 * before; the choice puts `@/workspace/project/<path>` into the words — where the agent finds the
 * file. A chat without a project has no list: undefined, and `@` is just a letter.
 */
export function useContextMentions(projectId: string | null): ComposerMentions | undefined {
  const trpc = useTRPC()
  const [asked, setAsked] = useState(false)
  const files = useQuery({
    ...trpc.projectFile.list.queryOptions({ projectId: projectId ?? '' }),
    enabled: projectId !== null && asked,
  })
  const onOpen = useCallback(() => setAsked(true), [])
  const paths = useMemo(
    () => (files.data ? files.data.files.map((file) => file.name) : null),
    [files.data],
  )
  return useMemo(() => {
    if (projectId === null) return undefined
    return {
      paths: paths !== null && paths.length > 0 ? paths : null,
      state: paths === null ? 'preparing' : paths.length === 0 ? 'none' : 'ready',
      onOpen,
      root: CONTEXT_MENTION_ROOT,
      texts: { label: contextText.mentionLabel, none: contextText.mentionNone },
    }
  }, [projectId, paths, onOpen])
}
