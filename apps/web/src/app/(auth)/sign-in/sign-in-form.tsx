'use client'

import { useSmartCaptcha } from '@repo/ui/captcha'
import {
  LoginForm,
  type AuthSubmitHandler,
  type LoginField,
  type LoginFormValues,
} from '@repo/ui/widgets/auth'
import { useRouter } from 'next/navigation'

import { captchaHeaders, useAuthUi } from '@/components/auth/auth-ui'
import { YandexSignIn } from '@/components/auth/yandex-sign-in'
import { isAuthErrorCode, mapAuthError } from '@/lib/auth-errors'
import { hardNavigate } from '@/lib/hard-navigate'
import { rememberPendingEmail } from '@/lib/pending-email'

const FIELDS: readonly LoginField[] = ['email', 'password']

export function SignInForm({
  redirectTo,
  notice,
  yandexFailure,
}: {
  redirectTo: string
  notice?: string
  /** Why the last sign-in with Yandex ID failed. */
  yandexFailure?: string
}) {
  const router = useRouter()
  const { authClient, captchaSiteKey } = useAuthUi()
  const captcha = useSmartCaptcha(captchaSiteKey)

  const onSubmit: AuthSubmitHandler<LoginFormValues, LoginField> = async (
    values,
    { captchaToken },
  ) => {
    const { error } = await authClient.signIn.email({
      email: values.email,
      password: values.password,
      rememberMe: true,
      fetchOptions: { headers: captchaHeaders(captchaToken) },
    })
    if (isAuthErrorCode(error, 'EMAIL_NOT_VERIFIED')) {
      rememberPendingEmail(values.email)
      router.push('/verify-email?reason=unverified')
      return
    }
    if (error) return mapAuthError(error, FIELDS)
    // A full page load: no client cache of an earlier account survives into this one.
    hardNavigate(redirectTo)
  }

  return (
    <>
      <LoginForm
        onSubmit={onSubmit}
        getCaptchaToken={captcha.execute}
        registerHref="/sign-up"
        forgotPasswordHref="/reset-password"
        notice={notice}
      />
      <YandexSignIn callbackURL={redirectTo} failure={yandexFailure} />
      {captcha.widget}
    </>
  )
}
