'use client'

import { chatInfoLines, chatInfoTitle, type ChatInfoKind } from '@repo/domain/tasks/chat-info'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Skeleton from '@mui/material/Skeleton'
import Typography from '@mui/material/Typography'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useId } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { callErrorText } from './call-error'

// `/usage`, `/status` and `/context` (owner's request of 15.11.2026): a small window with what the
// server read (`task.info`), in the words the bot of Telegram says too (`chatInfoLines`). Read anew
// on every opening: the numbers change with every turn.

export const chatInfoDialogText = Object.freeze({
  close: 'Закрыть',
  loading: 'Загружаем',
  usagePage: 'Открыть «Использование»',
})

export function ChatInfoDialog({
  kind,
  taskId,
  onClose,
}: {
  kind: ChatInfoKind
  /** null — a new chat: only the credits. */
  taskId: string | null
  onClose: () => void
}) {
  const trpc = useTRPC()
  const titleId = useId()
  const info = useQuery({
    ...trpc.task.info.queryOptions(taskId === null ? {} : { taskId }),
    staleTime: 0,
    gcTime: 0,
  })
  const shown = info.data ? chatInfoLines(kind, info.data) : null
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs" aria-labelledby={titleId}>
      <DialogTitle id={titleId} sx={{ display: 'flex', alignItems: 'center', pr: 1 }}>
        <Box component="span" sx={{ flex: 1 }}>
          {chatInfoTitle[kind]}
        </Box>
        <IconButton
          aria-label={chatInfoDialogText.close}
          onClick={onClose}
          sx={{ width: 44, height: 44 }}
        >
          <AppIcon name="close" size={18} />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        {info.isError ? (
          <Typography role="alert" variant="body2" color="error">
            {callErrorText(info.error)}
          </Typography>
        ) : shown === null ? (
          <Box
            role="status"
            aria-label={chatInfoDialogText.loading}
            sx={{ display: 'grid', gap: 1 }}
          >
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} variant="text" />
            ))}
          </Box>
        ) : (
          <Box sx={{ display: 'grid', gap: 1 }}>
            {shown.lines.map((line) => (
              <Typography key={line} variant="body2">
                {line}
              </Typography>
            ))}
          </Box>
        )}
        {kind === 'usage' ? (
          <Button
            component={Link}
            href="/settings/usage"
            onClick={onClose}
            sx={{ mt: 2, minHeight: 44 }}
          >
            {chatInfoDialogText.usagePage}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
