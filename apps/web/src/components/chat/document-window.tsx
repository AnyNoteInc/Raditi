'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { chatDocumentsOf, documentOfFile } from '@repo/domain/tasks/chat-documents'
import { BrandProgress } from '@repo/ui/brand-progress'
import { useMemo } from 'react'

import { documentText } from './chat-texts'
import { DocumentsPane } from './documents-pane'
import { useDialogFeed } from './use-dialog-feed'

/** «Страницы» of a chat over the whole window, opened on one version (Д4). */
export function DocumentWindow({ taskId, fileId }: { taskId: string; fileId: string }) {
  const { state } = useDialogFeed(taskId)
  const document = useMemo(
    () => documentOfFile(chatDocumentsOf(state.rows), fileId),
    [state.rows, fileId],
  )
  const target = useMemo(
    () => (document === null ? null : { name: document.name, fileId, seq: 1 }),
    [document, fileId],
  )
  if (state.head === null)
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <BrandProgress size={28} aria-label={documentText.loading} />
      </Box>
    )
  if (target === null)
    return (
      <Box sx={{ p: 4 }}>
        <Typography>{documentText.missing}</Typography>
      </Box>
    )
  return (
    <Box
      component="main"
      sx={{
        height: { xs: 'calc(100dvh - 32px)', lg: 'calc(100dvh - 24px)' },
        border: 1,
        borderColor: 'divider',
        borderRadius: '14px',
        bgcolor: 'background.paper',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <DocumentsPane taskId={taskId} rows={state.rows} target={target} standalone />
    </Box>
  )
}
