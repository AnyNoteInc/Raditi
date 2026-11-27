'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'

import { callErrorText } from '@/components/chat/call-error'
import { dialogListKey } from '@/components/chat/dialog-actions'
import { useTRPC } from '@/trpc/client'

/**
 * «Перенести в проект…» and «Убрать из проекта» of a chat (docs/plan/84-projects.md, ПР2): the
 * press, then every read of the list and of the projects again. While the agent works in the chat
 * the server refuses (TASK_PROJECT_BUSY) and its words are the answer.
 */
export function useMoveToProject() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const move = useMutation(trpc.task.moveToProject.mutationOptions())
  async function to(taskId: string, projectId: string | null): Promise<string | null> {
    try {
      await move.mutateAsync({ taskId, projectId })
      return null
    } catch (failure) {
      return callErrorText(failure)
    } finally {
      void queryClient.invalidateQueries({ queryKey: dialogListKey })
      void queryClient.invalidateQueries({ queryKey: trpc.project.pathKey() })
    }
  }
  return { to, busy: move.isPending }
}
