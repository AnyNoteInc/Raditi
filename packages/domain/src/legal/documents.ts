/**
 * The single registry of legal documents (texts live in apps/web/content/legal).
 * Bumping `version` makes users accept the document again.
 */
export const consentDocumentTypes = [
  'user_agreement',
  'privacy_policy',
  'pii_processing',
  'public_offer',
  'marketing',
] as const
export type ConsentDocumentType = (typeof consentDocumentTypes)[number]

export interface LegalDocument {
  slug: string
  title: string
  /** Consent the user gives for this document; null for informational pages. */
  consentType: ConsentDocumentType | null
  required: boolean
  /** Edition date, ISO. */
  version: string
}

export const legalDocuments = [
  {
    slug: 'user-agreement',
    title: 'Пользовательское соглашение',
    consentType: 'user_agreement',
    required: true,
    version: '2026-09-28',
  },
  {
    slug: 'public-offer',
    title: 'Публичная оферта',
    consentType: 'public_offer',
    required: true,
    version: '2026-09-28',
  },
  {
    slug: 'privacy-policy',
    title: 'Политика обработки персональных данных',
    consentType: 'privacy_policy',
    required: true,
    version: '2026-09-28',
  },
  {
    slug: 'consent',
    title: 'Согласие на обработку персональных данных',
    consentType: 'pii_processing',
    required: true,
    version: '2026-09-28',
  },
  {
    slug: 'marketing-consent',
    title: 'Согласие на получение рассылок',
    consentType: 'marketing',
    required: false,
    version: '2026-09-26',
  },
  {
    slug: 'information',
    title: 'Сведения об операторе',
    consentType: null,
    required: false,
    version: '2026-09-26',
  },
] as const satisfies readonly LegalDocument[]

export type LegalDocumentSlug = (typeof legalDocuments)[number]['slug']

export function findLegalDocument(slug: string): LegalDocument | undefined {
  return legalDocuments.find((d) => d.slug === slug)
}

/** The document a consent of this type is given to. */
export function legalDocumentFor(type: ConsentDocumentType): LegalDocument {
  const document = legalDocuments.find((d) => d.consentType === type)
  if (!document) throw new Error(`No legal document for consent type ${type}`)
  return document
}

export interface ConsentRecord {
  type: ConsentDocumentType
  version: string
  granted: boolean
}

/**
 * Required documents the user still has to accept, given the latest consent per type.
 * A consent to an older edition does not count.
 */
export function missingRequiredConsents(latest: readonly ConsentRecord[]): LegalDocument[] {
  return legalDocuments.filter((doc) => {
    if (!doc.required || doc.consentType === null) return false
    const record = latest.find((r) => r.type === doc.consentType)
    return !record || !record.granted || record.version !== doc.version
  })
}
