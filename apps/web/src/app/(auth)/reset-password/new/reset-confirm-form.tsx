'use client'

import {
  ResetPasswordConfirmForm,
  type AuthSubmitHandler,
  type ResetPasswordConfirmFormValues,
} from '@repo/ui/widgets/auth'

import { useAuthUi } from '@/components/auth/auth-ui'
import { INVALID_LINK_ERROR, isAuthErrorCode, mapAuthError } from '@/lib/auth-errors'

type Field = 'password' | 'confirmPassword'

export function ResetConfirmForm({
  token,
  linkError,
}: {
  token: string | null
  linkError: string | null
}) {
  const { authClient } = useAuthUi()

  const onSubmit: AuthSubmitHandler<ResetPasswordConfirmFormValues, Field> = async (values) => {
    if (!token) return { error: INVALID_LINK_ERROR }
    const { error } = await authClient.resetPassword({ newPassword: values.password, token })
    if (isAuthErrorCode(error, 'INVALID_TOKEN')) return { error: INVALID_LINK_ERROR }
    if (error) return mapAuthError(error, ['password'])
  }

  return (
    <ResetPasswordConfirmForm
      onSubmit={onSubmit}
      loginHref="/sign-in"
      requestResetHref="/reset-password"
      linkError={linkError}
    />
  )
}
