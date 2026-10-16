'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import Typography from '@mui/material/Typography'
import { useId, type ReactNode } from 'react'

/**
 * The frame of a confirmation that changes the tariff without a payment page: a question, what
 * the answer leads to, and two buttons. Nothing closes the dialog while the request is on its
 * way; a refusal stays inside it, so the customer reads it where they asked.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  children,
  busy,
  error,
  keepLabel,
  confirmLabel,
  danger = false,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** What the customer confirms: the accessible description of the dialog. */
  children: ReactNode
  busy: boolean
  /** Why the last try was refused, as a sentence; null before a try. */
  error: string | null
  /** The button that changes nothing: «Не менять», «Оставить включённым». */
  keepLabel: string
  confirmLabel: string
  /** The confirmation takes something away: its button is not the bright one. */
  danger?: boolean
  onConfirm: () => void
}) {
  const titleId = useId()
  const descriptionId = useId()

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: '100%',
            maxWidth: 480,
            m: 2,
            p: 3,
            border: 1,
            borderColor: 'divider',
            borderRadius: '14px',
          },
        },
      }}
    >
      <Typography
        component="h2"
        id={titleId}
        sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3, overflowWrap: 'anywhere' }}
      >
        {title}
      </Typography>
      <Box id={descriptionId}>{children}</Box>

      {error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      ) : null}

      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 1, mt: 3 }}>
        <Button onClick={onClose} disabled={busy}>
          {keepLabel}
        </Button>
        <Button
          variant={danger ? 'outlined' : 'contained'}
          color={danger ? 'error' : 'primary'}
          onClick={onConfirm}
          loading={busy}
        >
          {confirmLabel}
        </Button>
      </Box>
    </Dialog>
  )
}
