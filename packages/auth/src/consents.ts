import type { ConsentSource } from '@repo/db'
import {
  legalDocumentFor,
  missingRequiredConsents,
  type ConsentDocumentType,
  type ConsentRecord,
  type LegalDocument,
} from '@repo/domain'
import { z } from 'zod'

import type { RequestMeta } from './request-meta.ts'

/**
 * The required checkboxes and the documents each one grants. Since 1 September 2025 152-FZ
 * wants the consent to personal data processing given separately from any other document,
 * so it has a checkbox of its own. Together they cover every required document of the
 * registry in @repo/domain.
 */
export const requiredConsentCheckboxes = {
  /** User agreement, public offer and acknowledgement of the privacy policy. */
  acceptTerms: ['user_agreement', 'public_offer', 'privacy_policy'],
  /** The separate consent to personal data processing. */
  acceptPersonalData: ['pii_processing'],
} as const satisfies Record<string, readonly ConsentDocumentType[]>
export type RequiredConsentCheckbox = keyof typeof requiredConsentCheckboxes

/** Consent fields the sign-up form sends next to email, password and name. */
export const signUpConsentSchema = z.object({
  acceptTerms: z.literal(true),
  acceptPersonalData: z.literal(true),
  marketing: z.boolean().optional(),
})
export type SignUpConsent = z.infer<typeof signUpConsentSchema>

/** A user_consents row; the table is an append-only log. */
export interface ConsentRow {
  userId: string
  documentType: ConsentDocumentType
  granted: boolean
  documentVersion: string
  source: ConsentSource
  ipAddress: string | null
  userAgent: string | null
}

/** Stored consent as read from user_consents. */
export interface StoredConsent {
  documentType: ConsentDocumentType
  granted: boolean
  documentVersion: string
}

export interface ConsentContext extends RequestMeta {
  userId: string
  source: ConsentSource
}

export const MARKETING_CONSENT: ConsentDocumentType = 'marketing'

/** Latest record per document type from rows sorted newest first. */
export function latestConsents(rowsNewestFirst: readonly StoredConsent[]): ConsentRecord[] {
  const latest = new Map<ConsentDocumentType, ConsentRecord>()
  for (const row of rowsNewestFirst) {
    if (latest.has(row.documentType)) continue
    latest.set(row.documentType, {
      type: row.documentType,
      version: row.documentVersion,
      granted: row.granted,
    })
  }
  return [...latest.values()]
}

function row(document: LegalDocument, granted: boolean, context: ConsentContext): ConsentRow {
  if (!document.consentType) throw new Error(`${document.slug} takes no consent`)
  return {
    userId: context.userId,
    documentType: document.consentType,
    granted,
    documentVersion: document.version,
    source: context.source,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  }
}

/** Grants for the required documents whose current edition is not accepted yet. */
export function requiredConsentRows(
  latest: readonly ConsentRecord[],
  context: ConsentContext,
): ConsentRow[] {
  return missingRequiredConsents(latest).map((document) => row(document, true, context))
}

/**
 * The marketing choice, or null when it would repeat the current state. A grant must name
 * the current edition; a refusal stands whatever edition it was given for.
 */
export function marketingConsentRow(
  latest: readonly ConsentRecord[],
  granted: boolean,
  context: ConsentContext,
): ConsentRow | null {
  const document = legalDocumentFor(MARKETING_CONSENT)
  const current = latest.find((r) => r.type === MARKETING_CONSENT)
  const unchanged =
    current !== undefined &&
    current.granted === granted &&
    (!granted || current.version === document.version)
  return unchanged ? null : row(document, granted, context)
}

/**
 * Everything a sign-up records: a grant for each document of both required checkboxes (the
 * schema lets no sign-up through without them) and the marketing choice.
 */
export function signUpConsentRows(
  consent: SignUpConsent,
  context: Omit<ConsentContext, 'source'>,
): ConsentRow[] {
  const full: ConsentContext = { ...context, source: 'sign_up' }
  const granted = [
    ...requiredConsentCheckboxes.acceptTerms,
    ...requiredConsentCheckboxes.acceptPersonalData,
  ].map((type) => row(legalDocumentFor(type), true, full))
  const marketing = marketingConsentRow([], consent.marketing ?? false, full)
  return [...granted, ...(marketing ? [marketing] : [])]
}
