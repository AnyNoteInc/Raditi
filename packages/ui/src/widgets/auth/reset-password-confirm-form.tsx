'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'

import { Alert, Button, Stack } from '../../components/index.ts'
import { AuthHeader } from './auth-header.tsx'
import { createAuthSubmit } from './auth-submit.ts'
import { FormTextField } from './form-text-field.tsx'
import {
  PASSWORD_MIN_LENGTH,
  resetPasswordConfirmSchema,
  type ResetPasswordConfirmFormInput,
  type ResetPasswordConfirmFormValues,
} from './schemas.ts'
import type { AuthSubmitHandler, GetCaptchaToken } from './types.ts'

export type ResetPasswordConfirmFormProps = {
  onSubmit: AuthSubmitHandler<ResetPasswordConfirmFormValues, 'password' | 'confirmPassword'>
  getCaptchaToken?: GetCaptchaToken
  loginHref: string
  requestResetHref: string
  homeHref?: string
  /**
   * The link from the e-mail is broken or expired (the app knows it from the URL). The form is
   * replaced by this message and a way to request a new link.
   */
  linkError?: string | null
}

export function ResetPasswordConfirmForm({
  onSubmit,
  getCaptchaToken,
  loginHref,
  requestResetHref,
  homeHref,
  linkError,
}: ResetPasswordConfirmFormProps) {
  const form = useForm<ResetPasswordConfirmFormInput, unknown, ResetPasswordConfirmFormValues>({
    resolver: zodResolver(resetPasswordConfirmSchema),
    defaultValues: { password: '', confirmPassword: '' },
  })
  const submit = createAuthSubmit(form, onSubmit, getCaptchaToken)
  const { isSubmitting, isSubmitSuccessful, errors } = form.formState
  const formError = errors.root?.server?.message

  if (linkError) {
    return (
      <Stack spacing={3}>
        <AuthHeader title="Новый пароль" homeHref={homeHref} />
        <Alert severity="error">{linkError}</Alert>
        <Button href={requestResetHref} variant="contained" size="large" fullWidth>
          Запросить новую ссылку
        </Button>
      </Stack>
    )
  }

  if (isSubmitSuccessful) {
    return (
      <Stack spacing={3}>
        <AuthHeader title="Пароль изменён" homeHref={homeHref} />
        <Alert severity="success" role="status">
          Готово! Теперь входите с новым паролем.
        </Alert>
        <Button href={loginHref} variant="contained" size="large" fullWidth>
          Войти
        </Button>
      </Stack>
    )
  }

  return (
    <Stack component="form" noValidate onSubmit={submit} spacing={3}>
      <AuthHeader title="Новый пароль" homeHref={homeHref} />
      <Stack spacing={2.5}>
        <FormTextField
          control={form.control}
          name="password"
          type="password"
          label="Новый пароль"
          autoComplete="new-password"
          helperText={`Не короче ${PASSWORD_MIN_LENGTH} символов`}
          disabled={isSubmitting}
        />
        <FormTextField
          control={form.control}
          name="confirmPassword"
          type="password"
          label="Новый пароль ещё раз"
          autoComplete="new-password"
          disabled={isSubmitting}
        />
      </Stack>
      {formError ? <Alert severity="error">{formError}</Alert> : null}
      <Button type="submit" variant="contained" size="large" fullWidth loading={isSubmitting}>
        Сохранить пароль
      </Button>
    </Stack>
  )
}
