'use client'

import { projectLimits } from '@repo/domain/projects'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'

import { callErrorText } from '@/components/chat/call-error'
import { useTRPC } from '@/trpc/client'

import { projectPageText, projectsText } from './project-texts'

/**
 * «Инструкции» of a project (docs/plan/84-projects.md, ПР7; P-instructions): one field, «N из 8000»,
 * «Сохранить» and «Отмена». The server refuses a text that looks like a password or a key; an
 * empty field takes the instructions away. On a phone it takes the whole screen (P-phone-sheet).
 */
export function ProjectInstructionsDialog({
  projectId,
  initial,
  open,
  onClose,
}: {
  projectId: string
  initial: string
  open: boolean
  onClose: () => void
}) {
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'))
  const titleId = useId()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={fullScreen}
      aria-labelledby={titleId}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: { sm: 640 },
            m: { sm: 2 },
            border: { sm: 1 },
            borderColor: { sm: 'divider' },
            borderRadius: { xs: 0, sm: '14px' },
          },
        },
      }}
    >
      {open ? (
        <InstructionsForm
          projectId={projectId}
          initial={initial}
          titleId={titleId}
          onClose={onClose}
        />
      ) : null}
    </Dialog>
  )
}

function InstructionsForm({
  projectId,
  initial,
  titleId,
  onClose,
}: {
  projectId: string
  initial: string
  titleId: string
  onClose: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const save = useMutation(trpc.project.setInstructions.mutationOptions())
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const limit = projectLimits.instructionsChars
  const countId = useId()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await save.mutateAsync({ projectId, text })
      void queryClient.invalidateQueries({ queryKey: trpc.project.pathKey() })
      onClose()
    } catch (failure) {
      setError(callErrorText(failure))
    }
  }

  return (
    <Box
      component="form"
      noValidate
      onSubmit={(event: FormEvent) => void submit(event)}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: { xs: 2.5, sm: 3 } }}
    >
      <Typography id={titleId} component="h2" sx={{ fontSize: 20, fontWeight: 600 }}>
        {projectPageText.instructionsTitle}
      </Typography>
      <Typography sx={{ color: 'text.secondary', fontSize: 14 }}>
        {projectPageText.instructionsHint}
      </Typography>
      <TextField
        label={projectPageText.instructionsLabel}
        value={text}
        multiline
        minRows={8}
        maxRows={18}
        autoFocus
        onChange={(event) => setText(event.target.value)}
        slotProps={{ htmlInput: { maxLength: limit, 'aria-describedby': countId } }}
      />
      <Typography
        id={countId}
        variant="caption"
        color="text.secondary"
        sx={{ alignSelf: 'flex-end', mt: -1, fontVariantNumeric: 'tabular-nums' }}
      >
        {projectPageText.instructionsCount(text.length, limit)}
      </Typography>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button onClick={onClose} disabled={save.isPending} sx={{ minHeight: 44 }}>
          {projectsText.cancel}
        </Button>
        <Button type="submit" variant="contained" loading={save.isPending} sx={{ minHeight: 44 }}>
          {projectsText.save}
        </Button>
      </Box>
    </Box>
  )
}
