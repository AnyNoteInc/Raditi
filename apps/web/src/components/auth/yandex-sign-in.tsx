'use client'

import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useState } from 'react'

import { useAuthUi } from './auth-ui'

/** The query the sign-in page reads after a failed round trip; better-auth adds `error`. */
export const YANDEX_FAILED_PARAM = 'yandex'

const FAILED_TEXT = 'Не удалось войти через Яндекс ID. Попробуйте ещё раз.'

/** better-auth's error codes of the callback that a user can act on. */
const ERROR_TEXT: Record<string, string> = {
  account_not_linked:
    'Этот адрес уже зарегистрирован в Радити, но ещё не подтверждён. Войдите по почте и паролю и подтвердите адрес — после этого можно входить и через Яндекс ID.',
  access_denied: 'Вы не дали Радити доступ к Яндекс ID. Чтобы войти, разрешите доступ.',
}

/** The text for `?yandex=…&error=…` on the sign-in page, or undefined without a failure. */
export function yandexFailureText(params: {
  yandex?: string | string[]
  error?: string | string[]
}): string | undefined {
  if (params.yandex === undefined) return undefined
  const code = Array.isArray(params.error) ? params.error[0] : params.error
  return (code && ERROR_TEXT[code]) || FAILED_TEXT
}

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
      setError(FAILED_TEXT)
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
