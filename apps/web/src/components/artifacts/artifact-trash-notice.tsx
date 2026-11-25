'use client'

import Button from '@mui/material/Button'
import Snackbar from '@mui/material/Snackbar'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'

import { useTRPC } from '@/trpc/client'

// «В корзину» from the page of an artifact (docs/plan/93-artifacts-trim.md, АТ9): the page asks
// nothing, goes to the gallery, and the gallery says «Перемещено в корзину · Вернуть». What was
// trashed waits here, in the memory of the open tab, for the gallery to show it once.

export const trashNoticeTexts = Object.freeze({
  moved: 'Перемещено в корзину',
  undo: 'Вернуть',
  restored: (title: string) => `«${title}» снова в списке.`,
  failed: 'Не получилось вернуть. Откройте корзину и попробуйте ещё раз.',
})

type Notice = { artifactId: string; title: string; state: 'trashed' | 'restored' | 'failed' }

let current: Notice | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const set = (next: Notice | null) => {
  current = next
  listeners.forEach((listener) => listener())
}

/** Remembers an artifact just put in the trash, for the gallery to offer «Вернуть». */
export function rememberTrashed(artifactId: string, title: string) {
  set({ artifactId, title, state: 'trashed' })
}

/** The notice of the gallery about the artifact trashed from its page; nothing when there is none. */
export function ArtifactTrashNotice() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const notice = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
  const restore = useMutation(trpc.artifact.restore.mutationOptions())
  if (notice === null) return null
  const text =
    notice.state === 'trashed'
      ? trashNoticeTexts.moved
      : notice.state === 'restored'
        ? trashNoticeTexts.restored(notice.title)
        : trashNoticeTexts.failed
  return (
    <Snackbar
      open
      autoHideDuration={notice.state === 'trashed' ? 8000 : 4000}
      onClose={(_, reason) => {
        if (reason !== 'clickaway') set(null)
      }}
      message={text}
      action={
        notice.state === 'trashed' ? (
          <Button
            color="inherit"
            size="small"
            disabled={restore.isPending}
            onClick={() =>
              void restore
                .mutateAsync({ artifactId: notice.artifactId })
                .then(() => set({ ...notice, state: 'restored' }))
                .catch(() => set({ ...notice, state: 'failed' }))
                .finally(
                  () =>
                    void queryClient.invalidateQueries({ queryKey: trpc.artifact.list.pathKey() }),
                )
            }
          >
            {trashNoticeTexts.undo}
          </Button>
        ) : undefined
      }
    />
  )
}
