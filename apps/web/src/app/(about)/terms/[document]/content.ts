import consent from '@content/legal/consent.md'
import information from '@content/legal/information.md'
import marketingConsent from '@content/legal/marketing-consent.md'
import privacyPolicy from '@content/legal/privacy-policy.md'
import publicOffer from '@content/legal/public-offer.md'
import userAgreement from '@content/legal/user-agreement.md'
import type { LegalDocumentSlug } from '@repo/domain'
import type { MDXContent } from 'mdx/types'

/**
 * Texts of the legal documents (apps/web/content/legal), compiled by @next/mdx at build time.
 * A static map, not a filesystem read: the registry type makes a missing slug a type error.
 */
export const legalContent: Record<LegalDocumentSlug, MDXContent> = {
  'user-agreement': userAgreement,
  'public-offer': publicOffer,
  'privacy-policy': privacyPolicy,
  consent,
  'marketing-consent': marketingConsent,
  information,
}
