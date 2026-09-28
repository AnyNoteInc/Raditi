'use client'

import { useSmartCaptcha } from '@repo/ui/captcha'
import {
  RegisterForm,
  type AuthSubmitHandler,
  type ConsentDocumentLinks,
  type RegisterField,
  type RegisterFormValues,
} from '@repo/ui/widgets/auth'
import { useRouter } from 'next/navigation'

import { captchaHeaders, useAuthUi } from '@/components/auth/auth-ui'
import { mapAuthError } from '@/lib/auth-errors'
import { rememberPendingEmail } from '@/lib/pending-email'

const FIELDS: readonly RegisterField[] = [
  'name',
  'email',
  'password',
  'acceptTerms',
  'acceptPersonalData',
]

export function SignUpForm({ documents }: { documents: ConsentDocumentLinks }) {
  const router = useRouter()
  const { authClient, captchaSiteKey } = useAuthUi()
  const captcha = useSmartCaptcha(captchaSiteKey)

  const onSubmit: AuthSubmitHandler<RegisterFormValues, RegisterField> = async (
    values,
    { captchaToken },
  ) => {
    // Two separate required consents (152-FZ); the server checks and records both.
    const body = {
      name: values.name,
      email: values.email,
      password: values.password,
      acceptTerms: values.acceptTerms,
      acceptPersonalData: values.acceptPersonalData,
      marketing: values.marketing,
      // The link in the letter leads back here; once verified, the user lands in the cabinet.
      callbackURL: '/verify-email',
    }
    const { error } = await authClient.signUp.email({
      ...body,
      fetchOptions: { headers: captchaHeaders(captchaToken) },
    })
    if (error) return mapAuthError(error, FIELDS)
    rememberPendingEmail(values.email)
    router.push('/verify-email')
  }

  return (
    <>
      <RegisterForm
        onSubmit={onSubmit}
        getCaptchaToken={captcha.execute}
        documents={documents}
        loginHref="/sign-in"
      />
      {captcha.widget}
    </>
  )
}
