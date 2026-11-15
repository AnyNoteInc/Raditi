'use client'

import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'

import { useTRPC } from '@/trpc/client'

import type { ComposerMentions } from './composer'

/** How often the list is asked again while core reads the files. */
const WAIT_MS = 2_000

/**
 * The files `@` offers in a chat with the code of a project (docs/plan/78-file-mentions.md, У2):
 * the files of the chat's working copy (`siteFiles.list` with `taskId`), or of the site on
 * «Новый чат». They are read the first time `@` is typed, not when the page opens. `siteId` null
 * — no project, no files: no list.
 */
export function useMentionFiles(
  siteId: string | null,
  taskId?: string,
): ComposerMentions | undefined {
  const trpc = useTRPC()
  const [asked, setAsked] = useState(false)
  const list = useQuery({
    ...trpc.siteFiles.list.queryOptions({
      siteId: siteId ?? '',
      ...(taskId !== undefined ? { taskId } : {}),
    }),
    enabled: siteId !== null && asked,
    refetchInterval: (query) => (query.state.data?.state === 'preparing' ? WAIT_MS : false),
  })
  const onOpen = useCallback(() => setAsked(true), [])
  const data = list.data
  const paths = useMemo(
    () => (data?.state === 'ready' ? data.files.map((file) => file.path) : null),
    [data],
  )
  if (siteId === null) return undefined
  return {
    paths,
    state: data?.state === 'none' || list.isError ? 'none' : paths ? 'ready' : 'preparing',
    onOpen,
  }
}
