import type { Metadata } from 'next'

import { linkErrorMessage } from '@/lib/auth-errors'
import { redirectIfSignedIn } from '@/lib/auth-redirect'

import { VerifyEmailView } from './verify-email-view'

export const metadata: Metadata = { title: 'Подтверждение почты' }

/**
 * After sign-up, and where the link from the letter leads. A verified link signs the user in,
 * and the page sends them on to the cabinet; a broken one comes back with ?error=.
 */
export default async function VerifyEmailPage({ searchParams }: PageProps<'/verify-email'>) {
  await redirectIfSignedIn()
  const { error, reason } = await searchParams
  return (
    <VerifyEmailView
      linkError={linkErrorMessage(typeof error === 'string' ? error : undefined)}
      unverified={reason === 'unverified'}
    />
  )
}
