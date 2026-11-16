'use client'

import type { ReasoningEffort } from '@repo/domain/llm/model-class'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { useTRPC } from '@/trpc/client'

import { sendErrorText } from './call-error'
import { chatHref } from './chat-address'
import { dialogListKey } from './dialog-actions'
import { markNewDialog } from './new-dialog-hint'
import { rememberPrompt } from './prompt-history'
import { uuidv7 } from './uuid'

/**
 * The first words of a chat (docs/plan/61-chats-first.md, К6): the browser invents its id, so a
 * repeat after a lost answer finds the same chat, and the screen moves to it. `projectId` — the
 * project it starts in (docs/plan/84-projects.md, ПР30); null — none. «Новый чат» and the page of
 * a project start chats the same way.
 */
export function useStartChat({ userId, effort }: { userId: string; effort: ReasoningEffort }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  // One id per chat being started: a repeat after a lost answer lands on the same one.
  const pending = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const create = useMutation(trpc.task.create.mutationOptions())

  async function start(
    text: string,
    attachmentIds: readonly string[],
    projectId: string | null,
  ): Promise<boolean> {
    pending.current ??= uuidv7()
    setError(null)
    try {
      const created = await create.mutateAsync({
        taskId: pending.current,
        text,
        ...(attachmentIds.length > 0 ? { attachments: [...attachmentIds] } : {}),
        effort,
        projectId,
      })
      pending.current = null
      rememberPrompt(userId, text)
      void queryClient.invalidateQueries({ queryKey: dialogListKey })
      // A project counts its chats and its activity.
      if (projectId !== null)
        void queryClient.invalidateQueries({ queryKey: trpc.project.pathKey() })
      // The new chat set credits aside: the ring of the credits reads them again.
      void queryClient.invalidateQueries({ queryKey: trpc.billing.usage.queryKey() })
      // The client watches the chat from its start: a browser launched before its first read
      // opens beside it too (docs/plan/59, И3).
      markNewDialog(created.taskId)
      router.push(chatHref(created.taskId))
      return true
    } catch (failure) {
      setError(sendErrorText(failure))
      return false
    }
  }

  return { start, error, busy: create.isPending }
}
