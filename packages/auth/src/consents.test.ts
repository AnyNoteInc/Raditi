import { legalDocumentFor, legalDocuments, type ConsentRecord } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import {
  latestConsents,
  marketingConsentRow,
  requiredConsentCheckboxes,
  requiredConsentRows,
  signUpConsentRows,
  signUpConsentSchema,
  type ConsentContext,
} from './consents.ts'

const meta = { userId: 'user-1', ipAddress: '203.0.113.7', userAgent: 'Firefox' }
const onboarding: ConsentContext = { ...meta, source: 'onboarding' }
const required = legalDocuments.filter((d) => d.required && d.consentType !== null)
const marketing = legalDocumentFor('marketing')

const acceptedAll = (): ConsentRecord[] =>
  required.map((d) => ({ type: d.consentType!, version: d.version, granted: true }))

const both = { acceptTerms: true, acceptPersonalData: true } as const
const accepts = (body: unknown) => signUpConsentSchema.safeParse(body).success

describe('signUpConsentSchema', () => {
  it('requires both required checkboxes to be ticked', () => {
    expect(accepts(both)).toBe(true)
    expect(accepts({ ...both, marketing: false })).toBe(true)
    expect(accepts({ acceptTerms: true })).toBe(false)
    expect(accepts({ acceptPersonalData: true })).toBe(false)
    expect(accepts({ ...both, acceptTerms: false })).toBe(false)
    expect(accepts({ ...both, acceptPersonalData: false })).toBe(false)
    expect(accepts({ ...both, acceptPersonalData: 'true' })).toBe(false)
    expect(accepts({})).toBe(false)
  })

  it('accepts only a boolean marketing answer', () => {
    expect(accepts({ ...both, marketing: 'yes' })).toBe(false)
  })
})

describe('requiredConsentCheckboxes', () => {
  it('gives the personal data consent a checkbox of its own', () => {
    expect(requiredConsentCheckboxes).toEqual({
      acceptTerms: ['user_agreement', 'public_offer', 'privacy_policy'],
      acceptPersonalData: ['pii_processing'],
    })
  })

  it('covers every required document of the registry exactly once', () => {
    const covered = Object.values(requiredConsentCheckboxes).flat()
    expect(covered.toSorted()).toEqual(required.map((d) => d.consentType).toSorted())
  })
})

describe('signUpConsentRows', () => {
  it('records every required document in its current edition and the marketing choice', () => {
    const rows = signUpConsentRows({ ...both, marketing: true }, meta)

    expect(rows).toEqual([
      ...required.map((d) => ({
        ...meta,
        documentType: d.consentType,
        documentVersion: d.version,
        granted: true,
        source: 'sign_up',
      })),
      {
        ...meta,
        documentType: 'marketing',
        documentVersion: marketing.version,
        granted: true,
        source: 'sign_up',
      },
    ])
  })

  it('records a refusal of marketing when the box was left empty', () => {
    const rows = signUpConsentRows(both, meta)
    expect(rows.find((r) => r.documentType === 'marketing')?.granted).toBe(false)
    expect(rows.filter((r) => r.granted)).toHaveLength(required.length)
  })
})

describe('requiredConsentRows', () => {
  it('writes nothing when the current editions are accepted', () => {
    expect(requiredConsentRows(acceptedAll(), onboarding)).toEqual([])
  })

  it('writes only the documents with a new edition or a withdrawn consent', () => {
    const latest = acceptedAll()
    latest[0] = { ...latest[0]!, version: '2000-01-01' }
    latest[1] = { ...latest[1]!, granted: false }

    const rows = requiredConsentRows(latest, onboarding)

    expect(rows.map((r) => r.documentType)).toEqual([latest[0].type, latest[1].type])
    expect(rows.every((r) => r.granted && r.source === 'onboarding')).toBe(true)
  })
})

describe('marketingConsentRow', () => {
  const record = (granted: boolean, version = marketing.version): ConsentRecord => ({
    type: 'marketing',
    version,
    granted,
  })

  it('skips a repeat of the current state', () => {
    expect(marketingConsentRow([record(true)], true, onboarding)).toBeNull()
    expect(marketingConsentRow([record(false)], false, onboarding)).toBeNull()
    expect(marketingConsentRow([record(false, '2000-01-01')], false, onboarding)).toBeNull()
  })

  it('records a change, a first answer and a grant of a new edition', () => {
    expect(marketingConsentRow([record(true)], false, onboarding)?.granted).toBe(false)
    expect(marketingConsentRow([], false, onboarding)?.granted).toBe(false)
    expect(marketingConsentRow([record(true, '2000-01-01')], true, onboarding)).toMatchObject({
      granted: true,
      documentVersion: marketing.version,
    })
  })
})

describe('latestConsents', () => {
  it('keeps the newest row per document', () => {
    expect(
      latestConsents([
        { documentType: 'marketing', granted: false, documentVersion: 'v2' },
        { documentType: 'user_agreement', granted: true, documentVersion: 'v1' },
        { documentType: 'marketing', granted: true, documentVersion: 'v1' },
      ]),
    ).toEqual([
      { type: 'marketing', granted: false, version: 'v2' },
      { type: 'user_agreement', granted: true, version: 'v1' },
    ])
  })
})
