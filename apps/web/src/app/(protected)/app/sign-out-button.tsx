'use client'

import Button from '@mui/material/Button'
import { useTransition } from 'react'

import { hardNavigate } from '@/lib/hard-navigate'

import { signOut } from './actions'

/** Signs out, then loads the sign-in page afresh: no cached data of this account stays behind. */
export function SignOutButton() {
  const [pending, startTransition] = useTransition()

  const leave = () =>
    startTransition(async () => {
      // Leave even if the call failed: /sign-in sends a still signed-in user back to the cabinet.
      await signOut().catch(() => undefined)
      hardNavigate('/sign-in')
    })

  return (
    <Button variant="outlined" onClick={leave} loading={pending}>
      Выйти
    </Button>
  )
}
