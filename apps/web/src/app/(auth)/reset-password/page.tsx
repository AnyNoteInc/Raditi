import type { Metadata } from 'next'

import { redirectIfSignedIn } from '@/lib/auth-redirect'

import { ResetRequestForm } from './reset-request-form'

export const metadata: Metadata = { title: 'Восстановление пароля' }

export default async function ResetPasswordPage() {
  await redirectIfSignedIn()
  return <ResetRequestForm />
}
