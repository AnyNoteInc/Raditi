'use client'

import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useState } from 'react'

import { useAuthUi } from './auth-ui'
import { YANDEX_FAILED_PARAM, YANDEX_FAILED_TEXT } from './yandex-sign-in-failure'

/** «Войти с Яндекс ID» under the email form; nothing when the Yandex app is not configured. */
export function YandexSignIn({
  callbackURL,
  failure,
  note,
}: {
  /** A same-origin path to open after the sign-in. */
  callbackURL: string
  failure?: string
  note?: string
}) {
  const { authClient, yandexSignIn } = useAuthUi()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(failure)
  if (!yandexSignIn) return null

  const start = async () => {
    setPending(true)
    setError(undefined)
    // better-auth answers with the authorization URL and navigates there itself.
    const { error: failed } = await authClient.signIn.social({
      provider: 'yandex',
      callbackURL,
      errorCallbackURL: `/sign-in?${YANDEX_FAILED_PARAM}=failed`,
    })
    if (failed) {
      setPending(false)
      setError(YANDEX_FAILED_TEXT)
    }
  }

  return (
    <Stack spacing={2.5} sx={{ mt: 3 }}>
      <Divider>
        <Typography variant="body2" color="text.secondary">
          или
        </Typography>
      </Divider>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Button variant="outlined" size="large" fullWidth loading={pending} onClick={start}>
        Войти с Яндекс ID
      </Button>
      {note ? (
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
          {note}
        </Typography>
      ) : null}
    </Stack>
  )
}
