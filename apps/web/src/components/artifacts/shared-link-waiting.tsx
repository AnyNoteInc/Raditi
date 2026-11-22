'use client'

import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Snackbar from '@mui/material/Snackbar'
import { useState } from 'react'

/**
 * «Открыть то, чем с вами поделились» (docs/plan/88-artifacts.md, Ар33; board E-signin): after a
 * sign-up the cabinet opens on its own page, while the token of the link still waits an hour in
 * its cookie — the way back to /a, where the words of consent are.
 */
export function SharedLinkWaiting() {
  const [open, setOpen] = useState(true)
  return (
    <Snackbar open={open} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
      <Alert
        severity="info"
        onClose={() => setOpen(false)}
        action={
          <Button color="inherit" size="small" href="/a">
            Открыть
          </Button>
        }
      >
        С вами поделились артефактом.
      </Alert>
    </Snackbar>
  )
}
