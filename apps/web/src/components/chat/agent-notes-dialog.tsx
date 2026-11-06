'use client'

import Box from '@mui/material/Box'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ConfirmDialog } from '@/components/billing/confirm-dialog'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import { callErrorText } from './call-error'
import { agentNotesText } from './chat-texts'

/** The longest notes of a project (`BROWSER_AGENT_NOTES_MAX_CHARS`); the server checks it again. */
const NOTES_LIMIT = 2000

/**
 * «Сохранить в подсказки агенту» of an answer to `/init` (docs/plan/61-chats-first.md, К31): the
 * answer in a field the client edits, the notes of the project beside it, so that what is saved is
 * what they saw and left: the server refuses to replace notes other than those shown.
 */
export function AgentNotesDialog({
  siteId,
  text,
  current,
  onClose,
  onSaved,
}: {
  siteId: string
  /** The answer of the agent: what the field starts with. */
  text: string
  /** The notes of the project now; null — none. */
  current: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const save = useMutation(trpc.project.setAgentNotes.mutationOptions())
  const [notes, setNotes] = useState(text)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setError(null)
    try {
      await save.mutateAsync({ id: siteId, notes, seen: current })
      onSaved()
    } catch (failure) {
      setError(callErrorText(failure))
    }
    // After a refusal too: it may say that the notes changed, and the window shows the new ones.
    void queryClient.invalidateQueries({
      queryKey: trpc.project.agentNotes.queryKey({ id: siteId }),
    })
  }

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={agentNotesText.title}
      busy={save.isPending}
      error={error}
      keepLabel={agentNotesText.keep}
      confirmLabel={agentNotesText.confirm}
      onConfirm={() => void confirm()}
    >
      <Typography sx={{ mt: 1.5 }}>{nbsp(agentNotesText.body)}</Typography>
      <TextField
        label={agentNotesText.field}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        disabled={save.isPending}
        multiline
        minRows={4}
        maxRows={10}
        fullWidth
        autoComplete="off"
        helperText={agentNotesText.hint}
        sx={{ mt: 2 }}
        slotProps={{ htmlInput: { maxLength: NOTES_LIMIT } }}
      />
      {current === null ? null : (
        <Box sx={{ mt: 2 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {agentNotesText.current}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            tabIndex={0}
            sx={{
              mt: 0.5,
              maxHeight: 144,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {current}
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            {nbsp(agentNotesText.replaces)}
          </Typography>
        </Box>
      )}
    </ConfirmDialog>
  )
}
