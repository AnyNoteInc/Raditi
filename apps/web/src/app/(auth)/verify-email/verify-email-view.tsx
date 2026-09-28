'use client'

import { captchaErrorMessage, useSmartCaptcha } from '@repo/ui/captcha'
import { AuthHeader } from '@repo/ui/widgets/auth'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useState, useSyncExternalStore, type FormEvent } from 'react'
import { z } from 'zod'

import { captchaHeaders, useAuthUi } from '@/components/auth/auth-ui'
import { GENERIC_AUTH_ERROR, mapAuthError } from '@/lib/auth-errors'
import { readPendingEmail, rememberPendingEmail } from '@/lib/pending-email'

const emailSchema = z.email()
const noSubscription = () => () => {}

type ResendState =
  { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string }

export function VerifyEmailView({
  linkError,
  unverified,
}: {
  linkError: string | null
  unverified: boolean
}) {
  const { authClient, captchaSiteKey } = useAuthUi()
  const captcha = useSmartCaptcha(captchaSiteKey)
  // The address from the sign-up form of this tab; nothing on the server.
  const storedEmail = useSyncExternalStore(noSubscription, readPendingEmail, () => null)
  const [typedEmail, setTypedEmail] = useState<string | null>(null)
  const email = typedEmail ?? storedEmail ?? ''
  const [state, setState] = useState<ResendState>({ kind: 'idle' })

  async function resend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const address = email.trim()
    if (!emailSchema.safeParse(address).success) {
      setState({ kind: 'error', message: 'Проверьте адрес электронной почты: в нём есть ошибка.' })
      return
    }
    setState({ kind: 'sending' })

    let captchaToken: string | null
    try {
      captchaToken = await captcha.execute()
    } catch (error) {
      const message = captchaErrorMessage(error)
      setState(message ? { kind: 'error', message } : { kind: 'idle' })
      return
    }

    try {
      const { error } = await authClient.sendVerificationEmail({
        email: address,
        callbackURL: '/verify-email',
        fetchOptions: { headers: captchaHeaders(captchaToken) },
      })
      if (error) {
        setState({ kind: 'error', message: mapAuthError(error).error ?? GENERIC_AUTH_ERROR })
        return
      }
    } catch {
      setState({ kind: 'error', message: GENERIC_AUTH_ERROR })
      return
    }
    rememberPendingEmail(address)
    setState({ kind: 'sent' })
  }

  const intro = unverified
    ? 'Сначала подтвердите адрес почты: откройте ссылку из письма, которое мы отправили при регистрации.'
    : 'Мы отправили письмо со ссылкой. Откройте его и перейдите по ссылке — после этого вы попадёте в кабинет.'

  return (
    <Stack spacing={3}>
      <AuthHeader title="Подтвердите почту" />
      {linkError ? (
        <Alert severity="error">{linkError}</Alert>
      ) : (
        <Alert severity="info">{intro}</Alert>
      )}
      <Typography variant="body2" color="text.secondary">
        Письма нет через несколько минут? Проверьте папку «Спам» или отправьте письмо ещё раз.
      </Typography>
      <Stack component="form" noValidate spacing={2} onSubmit={resend}>
        <TextField
          type="email"
          label="Электронная почта"
          autoComplete="email"
          value={email}
          onChange={(event) => setTypedEmail(event.target.value)}
          disabled={state.kind === 'sending'}
          fullWidth
        />
        {state.kind === 'error' ? <Alert severity="error">{state.message}</Alert> : null}
        {state.kind === 'sent' ? (
          <Alert severity="success" role="status">
            Письмо отправлено. Проверьте почту.
          </Alert>
        ) : null}
        <Button type="submit" variant="contained" size="large" loading={state.kind === 'sending'}>
          Отправить письмо ещё раз
        </Button>
      </Stack>
      <Typography variant="body2" sx={{ textAlign: 'center' }}>
        <Link href="/sign-in">Вернуться ко входу</Link>
      </Typography>
      {captcha.widget}
    </Stack>
  )
}
