'use client'

import { useSmartCaptcha } from '@repo/ui/captcha'
import {
  ResetPasswordRequestForm,
  type AuthSubmitHandler,
  type ResetPasswordRequestFormValues,
} from '@repo/ui/widgets/auth'

import { captchaHeaders, useAuthUi } from '@/components/auth/auth-ui'
import { mapAuthError } from '@/lib/auth-errors'

/** Where the link from the letter leads; better-auth adds ?token= or ?error=INVALID_TOKEN. */
const RESET_CONFIRM_PATH = '/reset-password/new'

export function ResetRequestForm() {
  const { authClient, captchaSiteKey } = useAuthUi()
  const captcha = useSmartCaptcha(captchaSiteKey)

  const onSubmit: AuthSubmitHandler<ResetPasswordRequestFormValues, 'email'> = async (
    values,
    { captchaToken },
  ) => {
    // The answer is the same whether or not the address is registered.
    const { error } = await authClient.requestPasswordReset({
      email: values.email,
      redirectTo: RESET_CONFIRM_PATH,
      fetchOptions: { headers: captchaHeaders(captchaToken) },
    })
    if (error) return mapAuthError(error, ['email'])
  }

  return (
    <>
      <ResetPasswordRequestForm
        onSubmit={onSubmit}
        getCaptchaToken={captcha.execute}
        loginHref="/sign-in"
      />
      {captcha.widget}
    </>
  )
}
