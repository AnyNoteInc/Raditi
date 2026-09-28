import type { Metadata } from 'next'

import { redirectIfSignedIn } from '@/lib/auth-redirect'
import { safeRedirectTarget } from '@/lib/safe-redirect'

import { SignInForm } from './sign-in-form'

export const metadata: Metadata = { title: 'Вход' }

export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  const { next } = await searchParams
  const raw = typeof next === 'string' ? next : undefined
  const redirectTo = safeRedirectTarget(raw)
  await redirectIfSignedIn(redirectTo)
  return (
    <SignInForm redirectTo={redirectTo} notice={raw ? 'Войдите, чтобы продолжить.' : undefined} />
  )
}
