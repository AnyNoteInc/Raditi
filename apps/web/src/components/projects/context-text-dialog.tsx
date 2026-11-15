'use client'

import { projectFileLimits, projectLimits } from '@repo/domain/projects'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useId, useState, type FormEvent } from 'react'

import { callErrorText } from '@/components/chat/call-error'

import { contextText } from './project-texts'

/**
 * «Добавить текстовое содержимое» (docs/plan/84-projects.md, ПР8; P-context-text): «Название» and
 * «Текст» up to 100 000 characters with its count; the text is kept as a `.md` file of the context.
 * The server refuses a text that holds a password or a key, in its own words, and the window
 * stays with the text for the client to fix. On a phone it takes the whole screen.
 */
export function ContextTextDialog({
  open,
  onClose,
  onAdd,
}: {
  open: boolean
  onClose: () => void
  /** Resolves when the server took the text; throws what it refused. */
  onAdd: (input: { title: string; text: string }) => Promise<void>
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
      {open ? <TextForm titleId={titleId} onClose={onClose} onAdd={onAdd} /> : null}
    </Dialog>
  )
}

function TextForm({
  titleId,
  onClose,
  onAdd,
}: {
  titleId: string
  onClose: () => void
  onAdd: (input: { title: string; text: string }) => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [missing, setMissing] = useState<'title' | 'text' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const countId = useId()
  const limit = projectLimits.textChars

  async function submit(event: FormEvent) {
    event.preventDefault()
    // The window may stand inside another form — the window of a new project: React carries the
    // submit through the portal, and that form must not take it.
    event.stopPropagation()
    if (title.trim() === '') return setMissing('title')
    if (text.trim() === '') return setMissing('text')
    setBusy(true)
    setError(null)
    try {
      await onAdd({ title: title.trim(), text })
      onClose()
    } catch (failure) {
      setError(callErrorText(failure))
    } finally {
      setBusy(false)
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
        {contextText.textTitle}
      </Typography>
      <TextField
        label={contextText.textName}
        placeholder={contextText.textNamePlaceholder}
        value={title}
        required
        autoFocus
        error={missing === 'title'}
        helperText={missing === 'title' ? contextText.textNameRequired : undefined}
        onChange={(event) => {
          setTitle(event.target.value)
          setMissing(null)
        }}
        slotProps={{ htmlInput: { maxLength: projectFileLimits.titleChars } }}
      />
      <TextField
        label={contextText.textBody}
        value={text}
        required
        multiline
        minRows={8}
        maxRows={18}
        error={missing === 'text'}
        helperText={missing === 'text' ? contextText.textBodyRequired : undefined}
        onChange={(event) => {
          setText(event.target.value)
          setMissing(null)
        }}
        slotProps={{ htmlInput: { maxLength: limit, 'aria-describedby': countId } }}
      />
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'baseline', mt: -1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: '1 1 auto' }}>
          {contextText.textNote}
        </Typography>
        <Typography
          id={countId}
          variant="caption"
          color="text.secondary"
          sx={{ flex: 'none', fontVariantNumeric: 'tabular-nums' }}
        >
          {contextText.textCount(text.length, limit)}
        </Typography>
      </Box>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button onClick={onClose} disabled={busy} sx={{ minHeight: 44 }}>
          {contextText.textCancel}
        </Button>
        <Button type="submit" variant="contained" loading={busy} sx={{ minHeight: 44 }}>
          {contextText.textAdd}
        </Button>
      </Box>
    </Box>
  )
}
