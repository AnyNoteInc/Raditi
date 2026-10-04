'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'

import { Alert, Button, Link, Stack, Typography } from '../../components/index.ts'
import { AuthHeader } from './auth-header.tsx'
import { createAuthSubmit } from './auth-submit.ts'
import { FormTextField } from './form-text-field.tsx'
import { loginSchema, type LoginFormInput, type LoginFormValues } from './schemas.ts'
import type { AuthSubmitHandler, GetCaptchaToken } from './types.ts'

export type LoginField = Extract<keyof LoginFormInput, string>

export type LoginFormProps = {
  onSubmit: AuthSubmitHandler<LoginFormValues, LoginField>
  getCaptchaToken?: GetCaptchaToken
  registerHref: string
  forgotPasswordHref: string
  homeHref?: string
  defaultEmail?: string
  /** Information above the form, e.g. «Адрес подтверждён. Войдите, чтобы открыть проекты». */
  notice?: string
}

export function LoginForm({
  onSubmit,
  getCaptchaToken,
  registerHref,
  forgotPasswordHref,
  homeHref,
  defaultEmail = '',
  notice,
}: LoginFormProps) {
  const form = useForm<LoginFormInput, unknown, LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: defaultEmail, password: '' },
  })
  const submit = createAuthSubmit(form, onSubmit, getCaptchaToken)
  const { isSubmitting, errors } = form.formState
  const formError = errors.root?.server?.message

  return (
    <Stack component="form" noValidate onSubmit={submit} spacing={3}>
      <AuthHeader title="Вход в проекты" homeHref={homeHref} />
      {notice ? (
        <Alert severity="info" role="status">
          {notice}
        </Alert>
      ) : null}
      <Stack spacing={2.5}>
        <FormTextField
          control={form.control}
          name="email"
          type="email"
          label="Электронная почта"
          autoComplete="email"
          disabled={isSubmitting}
        />
        <FormTextField
          control={form.control}
          name="password"
          type="password"
          label="Пароль"
          autoComplete="current-password"
          disabled={isSubmitting}
        />
        <Link href={forgotPasswordHref} variant="body2" sx={{ alignSelf: 'flex-end' }}>
          Забыли пароль?
        </Link>
      </Stack>
      {formError ? <Alert severity="error">{formError}</Alert> : null}
      <Button type="submit" variant="contained" size="large" fullWidth loading={isSubmitting}>
        Войти
      </Button>
      <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
        Ещё нет аккаунта? <Link href={registerHref}>Зарегистрироваться</Link>
      </Typography>
    </Stack>
  )
}
