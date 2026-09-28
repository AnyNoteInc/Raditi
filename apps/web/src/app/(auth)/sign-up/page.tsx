import type { Metadata } from 'next'

import { redirectIfSignedIn } from '@/lib/auth-redirect'
import { consentDocumentLinks } from '@/lib/legal'

import { SignUpForm } from './sign-up-form'

export const metadata: Metadata = { title: 'Регистрация' }

export default async function SignUpPage() {
  await redirectIfSignedIn()
  return <SignUpForm documents={consentDocumentLinks()} />
}
