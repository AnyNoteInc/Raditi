import {
  latestConsents,
  marketingConsentRow,
  requiredConsentRows,
  type ConsentContext,
  type RequestMeta,
} from '@repo/auth'
import type { PrismaClient } from '@repo/db'
import { legalDocuments, type ConsentRecord } from '@repo/domain'

export type ConsentDb = Pick<PrismaClient, 'userConsent'>

export interface ConsentStatus {
  slug: string
  title: string
  /** Current edition. */
  version: string
  required: boolean
  /** The current edition is accepted. */
  accepted: boolean
  /** Edition of the standing consent; null when there is none or it was withdrawn. */
  acceptedVersion: string | null
}

export async function loadLatestConsents(db: ConsentDb, userId: string): Promise<ConsentRecord[]> {
  const rows = await db.userConsent.findMany({
    where: { userId },
    // uuid v7 ids break ties between rows written in one statement.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { documentType: true, granted: true, documentVersion: true },
  })
  return latestConsents(rows)
}

export async function listConsents(db: ConsentDb, userId: string): Promise<ConsentStatus[]> {
  const latest = await loadLatestConsents(db, userId)
  return legalDocuments.flatMap((document) => {
    if (document.consentType === null) return []
    const record = latest.find((r) => r.type === document.consentType)
    const acceptedVersion = record?.granted ? record.version : null
    return [
      {
        slug: document.slug,
        title: document.title,
        version: document.version,
        required: document.required,
        accepted: acceptedVersion === document.version,
        acceptedVersion,
      },
    ]
  })
}

/**
 * Onboarding (or a new edition of a document): accepts every required document whose
 * current edition is not accepted yet and records the marketing choice if it changed.
 * Returns the number of rows written.
 */
export async function acceptRequiredConsents(
  db: ConsentDb,
  input: RequestMeta & { userId: string; marketing: boolean },
): Promise<number> {
  const latest = await loadLatestConsents(db, input.userId)
  const context: ConsentContext = { ...input, source: 'onboarding' }
  const marketing = marketingConsentRow(latest, input.marketing, context)
  const rows = [...requiredConsentRows(latest, context), ...(marketing ? [marketing] : [])]
  if (rows.length > 0) await db.userConsent.createMany({ data: rows })
  return rows.length
}

/** Grants or withdraws the marketing consent from the settings page; false if nothing changed. */
export async function setMarketingConsent(
  db: ConsentDb,
  input: RequestMeta & { userId: string; granted: boolean },
): Promise<boolean> {
  const latest = await loadLatestConsents(db, input.userId)
  const row = marketingConsentRow(latest, input.granted, { ...input, source: 'settings' })
  if (!row) return false
  await db.userConsent.createMany({ data: [row] })
  return true
}
