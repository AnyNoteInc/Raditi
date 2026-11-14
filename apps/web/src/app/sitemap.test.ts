import { legalDocuments } from '@repo/domain'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const stand = vi.hoisted(() => ({ appUrl: 'https://raditi.example' }))

vi.mock('@/env', () => ({ env: { web: () => ({ appUrl: stand.appUrl }) } }))

const { default: sitemap, dynamic } = await import('./sitemap')
const { default: robots } = await import('./robots')

describe('sitemap.xml', () => {
  beforeEach(() => {
    stand.appUrl = 'https://raditi.example'
  })

  it('lists the landing first and then every legal document', () => {
    expect(sitemap().map((page) => page.url)).toEqual([
      'https://raditi.example/',
      ...legalDocuments.map((document) => `https://raditi.example/terms/${document.slug}`),
    ])
    expect(legalDocuments.length).toBeGreaterThan(0)
    // No page twice.
    expect(new Set(sitemap().map((page) => page.url)).size).toBe(legalDocuments.length + 1)
  })

  it('ranks the landing above the documents and dates a document by its edition', () => {
    const [landing, ...documents] = sitemap()

    expect(landing).toEqual({
      url: 'https://raditi.example/',
      changeFrequency: 'weekly',
      priority: 1,
    })
    expect(documents).toEqual(
      legalDocuments.map((document) => ({
        url: `https://raditi.example/terms/${document.slug}`,
        lastModified: document.version,
        changeFrequency: 'yearly',
        priority: 0.3,
      })),
    )
    for (const { lastModified } of documents) {
      expect(String(lastModified)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('takes the address of every page from the public address of the service', () => {
    stand.appUrl = 'http://localhost:3000/'

    for (const { url } of sitemap()) expect(url.startsWith('http://localhost:3000/')).toBe(true)
    expect(sitemap()[0]?.url).toBe('http://localhost:3000/')
  })

  it('lists no page that robots.txt closes, at the address robots.txt names', () => {
    const { rules, sitemap: address } = robots()
    if (Array.isArray(rules)) throw new Error('one rule is expected')
    const closed = [rules.disallow ?? []].flat()

    expect(address).toBe('https://raditi.example/sitemap.xml')
    for (const { url } of sitemap()) {
      const path = new URL(url).pathname
      expect(closed.filter((prefix) => path.startsWith(prefix))).toEqual([])
    }
  })

  it('reads the address when asked, not when built', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
