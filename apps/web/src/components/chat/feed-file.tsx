'use client'

import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useParams } from 'next/navigation'

import { AppIcon } from '@/components/application/app-icon'

import { fileSizeText } from './chat-format'

/** The words of a file of the agent in the chat. */
export const feedFileText = Object.freeze({
  download: 'Скачать',
  label: (name: string) => `Скачать файл «${name}»`,
})

/** Where the cabinet serves a file of a task: its own origin, for a member of the task. */
export const taskFileHref = (taskId: string, fileId: string): string =>
  `/api/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}`

/**
 * A file the agent made for the client in its turn (`feed.file`, docs/plan/66-chat-visuals.md,
 * В8–В10): its name and size, and «Скачать». The browser saves it, never opens it: the route
 * answers it as an attachment. The task is the one of the page (`/chats/{taskId}`).
 */
export function FeedFile({
  fileId,
  name,
  sizeBytes,
}: {
  fileId: string
  name: string
  sizeBytes: number
}) {
  const { taskId } = useParams<{ taskId?: string }>()
  if (typeof taskId !== 'string') return null
  const href = taskFileHref(taskId, fileId)
  return (
    <Box
      sx={{
        alignSelf: 'stretch',
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: { xs: 2, sm: 2.5 },
        py: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: '18px',
        bgcolor: 'background.paper',
        minWidth: 0,
      }}
    >
      <Box sx={{ display: 'flex', color: 'text.secondary', flexShrink: 0 }} aria-hidden>
        <AppIcon name="file" size={20} />
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography
          sx={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.35 }}
        >
          {name}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {fileSizeText(sizeBytes)}
        </Typography>
      </Box>
      <Link
        href={href}
        download={name}
        aria-label={feedFileText.label(name)}
        variant="body2"
        sx={{ flexShrink: 0, fontWeight: 600 }}
      >
        {feedFileText.download}
      </Link>
    </Box>
  )
}
