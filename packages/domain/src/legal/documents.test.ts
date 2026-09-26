import { describe, expect, it } from 'vitest'
import {
  findLegalDocument,
  legalDocuments,
  missingRequiredConsents,
  type ConsentRecord,
} from './documents.ts'

const required = legalDocuments.filter((d) => d.required && d.consentType !== null)
const acceptAll = (): ConsentRecord[] =>
  required.map((d) => ({ type: d.consentType!, version: d.version, granted: true }))

describe('legal documents', () => {
  it('has unique slugs and consent types', () => {
    const slugs = legalDocuments.map((d) => d.slug)
    const types = legalDocuments.flatMap((d) => (d.consentType ? [d.consentType] : []))
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(new Set(types).size).toBe(types.length)
  })

  it('finds a document by slug', () => {
    expect(findLegalDocument('public-offer')?.consentType).toBe('public_offer')
    expect(findLegalDocument('nope')).toBeUndefined()
  })

  it('requires every required document for a new user', () => {
    expect(missingRequiredConsents([]).map((d) => d.slug)).toEqual(required.map((d) => d.slug))
  })

  it('is satisfied when the current editions are accepted', () => {
    expect(missingRequiredConsents(acceptAll())).toEqual([])
  })

  it('asks again after a new edition or a withdrawal', () => {
    const records = acceptAll()
    records[0] = { ...records[0]!, version: '2000-01-01' }
    records[1] = { ...records[1]!, granted: false }
    expect(missingRequiredConsents(records).map((d) => d.consentType)).toEqual([
      records[0].type,
      records[1].type,
    ])
  })

  it('never requires marketing', () => {
    expect(missingRequiredConsents(acceptAll()).some((d) => d.consentType === 'marketing')).toBe(
      false,
    )
  })
})
