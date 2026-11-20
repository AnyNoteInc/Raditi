'use client'

import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'

import type { ComposerMentions } from '@/components/chat/composer'
import { mentionText } from '@/components/chat/chat-texts'
import { useTRPC } from '@/trpc/client'

/**
 * `@` names the artifacts of the client too (docs/plan/88-artifacts.md, Ар47): the third source
 * beside the files of a project and of its repository. The list is read when `@` is first typed;
 * the choice puts `@artifact:<id>` into the words, and core attaches that artifact to the chat
 * after checking the role. `files` — the mentions of the project, when the chat has one.
 */
export function useArtifactMentions(files: ComposerMentions | undefined): ComposerMentions {
  const trpc = useTRPC()
  const [asked, setAsked] = useState(false)
  const list = useQuery({
    ...trpc.artifact.list.queryOptions({ filter: 'all' }),
    enabled: asked,
  })
  const onOpenFiles = files?.onOpen
  const onOpen = useCallback(() => {
    setAsked(true)
    onOpenFiles?.()
  }, [onOpenFiles])
  const artifacts = useMemo(
    () => list.data?.map((row) => ({ id: row.id, title: row.title })) ?? null,
    [list.data],
  )
  return useMemo(
    () => ({
      paths: files?.paths ?? null,
      state: files ? files.state : 'none',
      onOpen,
      ...(files?.root !== undefined ? { root: files.root } : {}),
      texts: {
        label: mentionText.withArtifacts,
        none: files?.texts?.none ?? mentionText.nothing,
      },
      artifacts,
    }),
    [files, onOpen, artifacts],
  )
}
