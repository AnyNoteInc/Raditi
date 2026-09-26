import {
  legalDocuments,
  type ConsentDocumentType,
  type LegalDocument,
  type LegalDocumentSlug,
} from '@repo/domain'
import type { ConsentDocumentLinks } from '@repo/ui/widgets/auth'

export const legalDocumentHref = (slug: LegalDocumentSlug | LegalDocument['slug']): string =>
  `/terms/${slug}`

function hrefFor(type: ConsentDocumentType): string {
  const document = legalDocuments.find((d) => d.consentType === type)
  if (!document) throw new Error(`No legal document for consent type ${type}`)
  return legalDocumentHref(document.slug)
}

/** Links for the consent checkboxes (sign-up and onboarding). */
export function consentDocumentLinks(): ConsentDocumentLinks {
  return {
    userAgreement: hrefFor('user_agreement'),
    publicOffer: hrefFor('public_offer'),
    privacyPolicy: hrefFor('privacy_policy'),
    piiProcessing: hrefFor('pii_processing'),
    marketing: hrefFor('marketing'),
  }
}

const editionFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

/** '2026-09-26' → '26 сентября 2026 г.' */
export function formatEditionDate(version: string): string {
  const date = new Date(`${version}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? version : editionFormat.format(date)
}
