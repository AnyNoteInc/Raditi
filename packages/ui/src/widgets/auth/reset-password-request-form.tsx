'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'

import { Alert, Button, Link, Stack, Typography } from '../../components/index.ts'
import { AuthHeader } from './auth-header.tsx'
import { createAuthSubmit } from './auth-submit.ts'
import { FormTextField } from './form-text-field.tsx'
import {
  resetPasswordRequestSchema,
  type ResetPasswordRequestFormInput,
  type ResetPasswordRequestFormValues,
} from './schemas.ts'
import type { AuthSubmitHandler, GetCaptchaToken } from './types.ts'

export const RESET_REQUEST_SENT_MESSAGE =
  'Если такой адрес зарегистрирован, мы отправили на него письмо со ссылкой для смены пароля. Письма нет через несколько минут — проверьте папку «Спам».'

export type ResetPasswordRequestFormProps = {
  onSubmit: AuthSubmitHandler<ResetPasswordRequestFormValues, 'email'>
  getCaptchaToken?: GetCaptchaToken
  loginHref: string
  homeHref?: string
  defaultEmail?: string
  /** Replaces the default text shown after a successful request. */
  successMessage?: string
}

export function ResetPasswordRequestForm({
  onSubmit,
  getCaptchaToken,
  loginHref,
  homeHref,
  defaultEmail = '',
  successMessage = RESET_REQUEST_SENT_MESSAGE,
}: ResetPasswordRequestFormProps) {
  const form = useForm<ResetPasswordRequestFormInput, unknown, ResetPasswordRequestFormValues>({
    resolver: zodResolver(resetPasswordRequestSchema),
    defaultValues: { email: defaultEmail },
  })
  const submit = createAuthSubmit(form, onSubmit, getCaptchaToken)
  const { isSubmitting, isSubmitSuccessful, errors } = form.formState
  const formError = errors.root?.server?.message

  return (
    <Stack component="form" noValidate onSubmit={submit} spacing={3}>
      <AuthHeader
        title="Восстановление пароля"
        subtitle="Укажите адрес, с которым вы регистрировались, — пришлём ссылку для смены пароля."
        homeHref={homeHref}
      />
      {isSubmitSuccessful ? (
        <Alert severity="success" role="status">
          {successMessage}
        </Alert>
      ) : null}
      <FormTextField
        control={form.control}
        name="email"
        type="email"
        label="Электронная почта"
        autoComplete="email"
        disabled={isSubmitting}
      />
      {formError ? <Alert severity="error">{formError}</Alert> : null}
      <Button type="submit" variant="contained" size="large" fullWidth loading={isSubmitting}>
        {isSubmitSuccessful ? 'Отправить ещё раз' : 'Отправить ссылку'}
      </Button>
      <Typography variant="body2" sx={{ textAlign: 'center' }}>
        <Link href={loginHref}>Вернуться ко входу</Link>
      </Typography>
    </Stack>
  )
}
