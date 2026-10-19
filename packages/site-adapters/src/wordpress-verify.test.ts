import type { SiteFacts } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { wordpressAdapter } from './wordpress.ts'
import { wordpressFailureMarkers } from './wordpress-verify.ts'

const site: SiteFacts = {
  stack: 'wordpress',
  url: 'https://shop.example.ru',
  docroot: '/var/www/shop',
  extras: {},
}

describe('the WordPress check after a release (plan 53, Р30)', () => {
  it('checks the front page of the install and nothing a security plugin may hide', () => {
    expect(wordpressAdapter.verify(site)).toEqual({
      pages: ['/'],
      logFiles: ['wp-content/debug.log'],
      screenshots: [],
      failureMarkers: [...wordpressFailureMarkers],
      // A published page or post the release created, by its number on production.
      recordPages: { page: '/?page_id={id}', post: '/?p={id}' },
    })
  })

  it('checks a WordPress in a subfolder there', () => {
    const blog = wordpressAdapter.verify({ ...site, url: 'https://example.ru/blog' })
    expect(blog.pages).toEqual(['/blog/'])
    expect(blog.recordPages).toEqual({ page: '/blog/?page_id={id}', post: '/blog/?p={id}' })
    expect(wordpressAdapter.verify({ ...site, url: 'http://localhost:8080/' }).pages).toEqual(['/'])
  })

  it('refuses an address that is not http(s)', () => {
    for (const url of ['ftp://example.ru', 'example.ru', ''])
      expect(() => wordpressAdapter.verify({ ...site, url })).toThrow(/http\(s\)/)
  })

  it('knows the fatal error pages of core in English and Russian and PHP’s own message', () => {
    // Each fits the manifest (4–200 characters) and no two overlap.
    for (const marker of wordpressFailureMarkers) {
      expect(marker.length).toBeGreaterThanOrEqual(4)
      expect(marker.length).toBeLessThanOrEqual(200)
    }
    expect(wordpressFailureMarkers).toContain('There has been a critical error on this website')
    expect(wordpressFailureMarkers).toContain('<b>Fatal error</b>:')
    // A page that mentions an error in its text is not a marker: the forms are exact.
    const page = '<p>Fatal errors in PHP are covered in our blog.</p>'
    expect(wordpressFailureMarkers.some((marker) => page.includes(marker))).toBe(false)
  })
})
