import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { legalDocuments } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { consentDocumentLinks, formatEditionDate, legalDocumentHref } from './legal'

const contentDir = fileURLToPath(new URL('../../content/legal/', import.meta.url))

describe('legal documents', () => {
  it('every document of the registry has a text and every text is in the registry', () => {
    const files = readdirSync(contentDir)
      .filter((file) => file.endsWith('.md') && file !== 'README.md')
      .map((file) => file.slice(0, -'.md'.length))
      .sort()
    const slugs = legalDocuments.map((document) => document.slug).sort()

    expect(files).toEqual(slugs)
  })

  it('consent checkboxes link to the documents of the registry', () => {
    const hrefs = new Set(legalDocuments.map((document) => legalDocumentHref(document.slug)))
    for (const href of Object.values(consentDocumentLinks())) expect(hrefs).toContain(href)
    expect(consentDocumentLinks().piiProcessing).toBe('/terms/consent')
  })

  it('formats the edition date in Russian', () => {
    expect(formatEditionDate('2026-09-26')).toBe('26 сентября 2026 г.')
    expect(formatEditionDate('not a date')).toBe('not a date')
  })
})
