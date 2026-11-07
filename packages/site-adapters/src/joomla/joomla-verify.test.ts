import type { SiteFacts } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { joomlaFailureMarkers, joomlaVerifyPlan } from './joomla-verify.ts'

const site = (url: string): SiteFacts => ({ stack: 'joomla', url, docroot: '/var/www', extras: {} })

describe('joomlaVerifyPlan', () => {
  it('checks the front page for the markers of a broken Joomla and reads its log', () => {
    expect(joomlaVerifyPlan(site('https://shop.example.ru'))).toEqual({
      pages: ['/'],
      logFiles: ['administrator/logs/error.php'],
      screenshots: [],
      failureMarkers: [...joomlaFailureMarkers],
    })
  })

  it('knows the pages of a broken Joomla word for word (joomla.md, §9.2)', () => {
    // The release compares them byte for byte: a typo would leave a broken site installed.
    expect(joomlaFailureMarkers).toEqual([
      'No configuration file found and no installation code available',
      'Sorry, your PHP version is not supported',
      'Environment Setup Incomplete',
      'Database Error: ',
      'Sorry, there was a problem we could not recover from.',
      'An Error Occurred: ',
      'Произошла критическая ошибка',
      '<b>Fatal error</b>:',
      '<b>Parse error</b>:',
    ])
    // Each fits the manifest (4–200 characters).
    for (const marker of joomlaFailureMarkers) {
      expect(marker.length).toBeGreaterThanOrEqual(4)
      expect(marker.length).toBeLessThanOrEqual(200)
    }
    // A page that mentions an error in its text is not a marker: the forms are exact.
    const page =
      '<p>A database error or a fatal error in PHP? An error occurred on our old site, see the blog.</p>'
    expect(joomlaFailureMarkers.some((marker) => page.includes(marker))).toBe(false)
  })

  it('checks a Joomla in a subfolder there', () => {
    expect(joomlaVerifyPlan(site('https://example.ru/shop')).pages).toEqual(['/shop/'])
    expect(joomlaVerifyPlan(site('http://example.ru/shop/')).pages).toEqual(['/shop/'])
  })

  it('carries no pages of records: a release of Joomla has no plan of the database', () => {
    expect(joomlaVerifyPlan(site('https://example.ru')).recordPages).toBeUndefined()
  })

  it('returns a copy of the markers', () => {
    joomlaVerifyPlan(site('https://example.ru')).failureMarkers.length = 0
    expect(joomlaVerifyPlan(site('https://example.ru')).failureMarkers).toHaveLength(
      joomlaFailureMarkers.length,
    )
  })

  it.each(['ftp://example.ru/', 'example.ru', ''])('refuses the address %j', (url) => {
    expect(() => joomlaVerifyPlan(site(url))).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
  })
})
