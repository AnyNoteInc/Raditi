import { mediaLimits, mediaRulesSchema } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { mediaRequestDenied, pageAsset, phpMediaRules, segmentsOf } from './media.ts'

describe('phpMediaRules', () => {
  // The media rules of WordPress before they moved here (wordpress-working-set.ts), word for word.
  const jpeg = [{ offset: 0, hex: 'ffd8ff' }]
  const wordpressBefore = {
    addOnlyPaths: ['wp-content/uploads/raditi/'],
    extensions: {
      jpg: jpeg,
      jpeg,
      png: [{ offset: 0, hex: '89504e470d0a1a0a' }],
      gif: [
        { offset: 0, hex: '47494638' },
        { offset: 5, hex: '61' },
      ],
      webp: [
        { offset: 0, hex: '52494646' },
        { offset: 8, hex: '57454250' },
      ],
      avif: [{ offset: 4, hex: '66747970617669' }],
      mp4: [{ offset: 4, hex: '66747970' }],
      webm: [{ offset: 0, hex: '1a45dfa3' }],
      pdf: [{ offset: 0, hex: '255044462d' }],
      woff2: [{ offset: 0, hex: '774f4632' }],
    },
    refusedNameParts: ['.php', '.pht', '.phar', '.htaccess', '.user.ini', '.svg'],
    maxFileBytes: mediaLimits.fileBytes,
  }

  it('is the former object of WordPress but for the folder', () => {
    const rules = phpMediaRules('x/')
    expect(rules.addOnlyPaths).toEqual(['x/'])
    expect({ ...rules, addOnlyPaths: wordpressBefore.addOnlyPaths }).toEqual(wordpressBefore)
    expect(mediaRulesSchema.parse(rules)).toEqual(rules)
  })

  it('returns a copy each time', () => {
    phpMediaRules('x/').extensions.jpg!.length = 0
    expect(phpMediaRules('x/').extensions.jpg).toHaveLength(1)
  })
})

describe('mediaRequestDenied', () => {
  // The cases of the media library of wordpress-browser.test.ts, on the shared rule.
  const roots = [['wp-content', 'uploads']]
  const own = ['wp-content', 'uploads', 'raditi']
  const denied = (path: string) => {
    const segments = segmentsOf(new URL(path, 'https://site.invalid').pathname)
    return segments === null || mediaRequestDenied(segments, roots, own)
  }

  it.each([
    '/wp-content/uploads/2024/05/hero.jpg',
    '/wp-content/uploads/2024/05/hero-1024x768.WEBP?ver=2',
    '/wp-content/uploads/elementor/css/post-12.css',
    '/wp-content/uploads/fonts/inter.woff2',
    '/wp-content/uploads/2024/05/intro.mp4',
    '/wp-content/uploads/raditi/price-list.pdf',
    '/wp-content/uploads/raditi/notes.txt',
    '/wp-content/themes/shop/readme.txt',
    '/',
  ])('opens %s', (path) => {
    expect(denied(path)).toBe(false)
  })

  it.each([
    '/wp-content/uploads/2024/05/resume.pdf',
    '/wp-content/uploads/2024/05/orders.csv',
    '/wp-content/uploads/2024/05/request.txt',
    '/wp-content/uploads/2024/05/request.TXT',
    '/wp-content/uploads/2024/05/form.html',
    '/wp-content/uploads/2024/05/backup.zip',
    '/wp-content/uploads/some-forms/entry-12.json',
    '/wp-content/uploads/2024/05/',
    '/wp-content/uploads',
    '/WP-CONTENT/Uploads/2024/05/resume.pdf',
    '/wp-content//uploads/2024/05/resume.pdf',
    '/wp-content/uploads/2024/05/resume%2Epdf',
    '/wp-content/uploads/2024/05/resume.pdf?x=.png',
    '/wp-content/uploads/raditi',
    '/wp-content/uploads/raditi/..%2f2024/05/resume.pdf',
    '/wp-content/themes/..%2f..%2fuploads/2024/05/resume.pdf',
  ])('refuses %s', (path) => {
    expect(denied(path)).toBe(true)
  })

  it('reads every root, and the own folder only below its last part', () => {
    const twoRoots = [['images'], ['files']]
    const mine = ['images', 'raditi']
    expect(mediaRequestDenied(['files', 'price.pdf'], twoRoots, mine)).toBe(true)
    expect(mediaRequestDenied(['files', 'logo.png'], twoRoots, mine)).toBe(false)
    expect(mediaRequestDenied(['images', 'raditi'], twoRoots, mine)).toBe(true)
    expect(mediaRequestDenied(['images', 'raditi', 'a.pdf'], twoRoots, mine)).toBe(false)
    expect(mediaRequestDenied(['imagesx', 'a.pdf'], twoRoots, mine)).toBe(false)
  })
})

describe('segmentsOf and pageAsset', () => {
  it('decodes, lowers and refuses what cannot be read plainly', () => {
    expect(segmentsOf('/A/%62/./c//')).toEqual(['a', 'b', 'c'])
    for (const path of ['/a/../b', '/a/%2e%2e/b', '/%E0%A4%A', '/a%00', '/a%5cb'])
      expect(segmentsOf(path), path).toBeNull()
  })

  it('knows the files a page draws with', () => {
    for (const name of ['a.png', 'a.min.css', 'a.js', 'a.woff2', 'a.webm'])
      expect(pageAsset.test(name)).toBe(true)
    for (const name of ['a.pdf', 'a.txt', 'a.html', 'a.json', 'a.png.php'])
      expect(pageAsset.test(name)).toBe(false)
  })
})
