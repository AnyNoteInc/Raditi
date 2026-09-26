import type { Metadata } from 'next'

import { INVALID_LINK_ERROR } from '@/lib/auth-errors'

import { ResetConfirmForm } from './reset-confirm-form'

export const metadata: Metadata = { title: 'Новый пароль' }

export default async function NewPasswordPage({ searchParams }: PageProps<'/reset-password/new'>) {
  const { token, error } = await searchParams
  const validToken = typeof token === 'string' && token.length > 0 && !error ? token : null
  return <ResetConfirmForm token={validToken} linkError={validToken ? null : INVALID_LINK_ERROR} />
}
