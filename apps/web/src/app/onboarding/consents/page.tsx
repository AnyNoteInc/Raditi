import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { hasRequiredConsents, requireSession, UNAVAILABLE } from '@/lib/access'
import { consentDocumentLinks } from '@/lib/legal'

import { AutoRenewalNotice } from './auto-renewal-notice'
import { ConsentsForm } from './consents-form'

export const metadata: Metadata = { title: 'Согласие с документами' }

/** New users who missed a consent and everyone after a new edition of a required document. */
export default async function OnboardingConsentsPage() {
  // Pages render alongside their layout, so the page checks the (cached) session itself.
  if ((await requireSession()) === UNAVAILABLE) return <ServiceUnavailable />
  const accepted = await hasRequiredConsents()
  if (accepted === UNAVAILABLE) return <ServiceUnavailable />
  if (accepted) redirect('/projects')
  return (
    <>
      <ConsentsForm documents={consentDocumentLinks()} />
      {/* Below the form and out of its way: a charge that is coming whatever the user answers. */}
      <AutoRenewalNotice />
    </>
  )
}
