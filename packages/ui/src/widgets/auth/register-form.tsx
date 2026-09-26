'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useController, useForm } from 'react-hook-form'

import { Alert, Button, Link, Stack, Typography } from '../../components/index.ts'
import { AuthHeader } from './auth-header.tsx'
import { createAuthSubmit } from './auth-submit.ts'
import { ConsentsCheckboxes, type ConsentDocumentLinks } from './consents-checkboxes.tsx'
import { FormTextField } from './form-text-field.tsx'
import {
  PASSWORD_MIN_LENGTH,
  registerSchema,
  type RegisterFormInput,
  type RegisterFormValues,
} from './schemas.ts'
import type { AuthSubmitHandler, GetCaptchaToken } from './types.ts'

export type RegisterField = Extract<keyof RegisterFormInput, string>

export type RegisterFormProps = {
  /**
   * `values.acceptTerms` and `values.acceptPersonalData` are always true; send both with
   * `values.marketing` to the sign-up so the server records the consents.
   */
  onSubmit: AuthSubmitHandler<RegisterFormValues, RegisterField>
  getCaptchaToken?: GetCaptchaToken
  documents: ConsentDocumentLinks
  loginHref: string
  homeHref?: string
  defaultEmail?: string
}

export function RegisterForm({
  onSubmit,
  getCaptchaToken,
  documents,
  loginHref,
  homeHref,
  defaultEmail = '',
}: RegisterFormProps) {
  const form = useForm<RegisterFormInput, unknown, RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      name: '',
      email: defaultEmail,
      password: '',
      confirmPassword: '',
      acceptTerms: false,
      acceptPersonalData: false,
      marketing: false,
    },
  })
  const terms = useController({ control: form.control, name: 'acceptTerms' })
  const personalData = useController({ control: form.control, name: 'acceptPersonalData' })
  const marketing = useController({ control: form.control, name: 'marketing' })
  const submit = createAuthSubmit(form, onSubmit, getCaptchaToken)
  const { isSubmitting, errors } = form.formState
  const formError = errors.root?.server?.message

  return (
    <Stack component="form" noValidate onSubmit={submit} spacing={3}>
      <AuthHeader title="Регистрация" homeHref={homeHref} />
      <Stack spacing={2.5}>
        <FormTextField
          control={form.control}
          name="name"
          label="Как к вам обращаться"
          autoComplete="name"
          disabled={isSubmitting}
        />
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
          autoComplete="new-password"
          helperText={`Не короче ${PASSWORD_MIN_LENGTH} символов`}
          disabled={isSubmitting}
        />
        <FormTextField
          control={form.control}
          name="confirmPassword"
          type="password"
          label="Пароль ещё раз"
          autoComplete="new-password"
          disabled={isSubmitting}
        />
      </Stack>
      <ConsentsCheckboxes
        documents={documents}
        acceptTerms={terms.field.value}
        onAcceptTermsChange={terms.field.onChange}
        acceptTermsError={terms.fieldState.error?.message}
        acceptTermsInputRef={terms.field.ref}
        acceptPersonalData={personalData.field.value}
        onAcceptPersonalDataChange={personalData.field.onChange}
        acceptPersonalDataError={personalData.fieldState.error?.message}
        acceptPersonalDataInputRef={personalData.field.ref}
        marketing={marketing.field.value}
        onMarketingChange={marketing.field.onChange}
        disabled={isSubmitting}
      />
      {formError ? <Alert severity="error">{formError}</Alert> : null}
      <Button
        type="submit"
        variant="contained"
        size="large"
        fullWidth
        disabled={!terms.field.value || !personalData.field.value}
        loading={isSubmitting}
      >
        Зарегистрироваться
      </Button>
      <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
        Уже есть кабинет? <Link href={loginHref}>Войти</Link>
      </Typography>
    </Stack>
  )
}
