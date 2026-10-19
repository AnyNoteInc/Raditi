import type { SiteFacts } from '@repo/domain'
import {
  addOnlyPathOf,
  agentWorkingSetSchema,
  isForbiddenPath,
  mediaContentProblem,
  mediaNameProblem,
  mediaRulesSchema,
  siteWorkspaceRules,
  workingSetMatcher,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { wordpressAdapter } from './wordpress.ts'

const site: SiteFacts = {
  stack: 'wordpress',
  url: 'https://shop.example.ru',
  docroot: '/var/www/shop',
  extras: {},
}

describe('the WordPress working set (plan 53, Р11)', () => {
  const set = agentWorkingSetSchema.parse(wordpressAdapter.agentWorkingSet(site))
  const inSet = workingSetMatcher(set)

  it.each([
    'wp-content/themes/shop/style.css',
    'wp-content/themes/shop/functions.php',
    'wp-content/plugins/forms/forms.php',
    'wp-content/mu-plugins/shop-tweaks.php',
    'wp-content/themes/shop/.htaccess',
  ])('gives the agent %s', (path) => {
    expect(inSet(path)).toBe(true)
  })

  // The owner's answer of 19.10.2026: the root is the core of WordPress, never the agent's.
  it.each(['robots.txt', 'google1234.html', '.htaccess', '.user.ini', 'php.ini', 'custom.php'])(
    'leaves the root file %s out of the sandbox',
    (path) => {
      expect(inSet(path)).toBe(false)
    },
  )

  it.each([
    'wp-config.php',
    'wp-config.php.bak',
    'wp-login.php',
    'wp-settings.php',
    'index.php',
    'xmlrpc.php',
    'license.txt',
    'readme.html',
    'wp-admin/index.php',
    'wp-includes/version.php',
    'wp-content/uploads/2026/10/photo.jpg',
    'wp-content/uploads/raditi.jpg',
    // The agent's own media: it adds there, it is never given what is there (it only grows).
    'wp-content/uploads/raditi/2026/10/hero.webp',
    'wp-content/index.php',
    'wp-content/advanced-cache.php',
    'wp-content/cache/page.html',
    'wp-content/mu-plugins/raditi-content.php',
    'wp-content/mu-plugins/raditi-preview.php',
    'wp-content/plugins/shop/vendor/autoload.php',
    'wp-content/themes/shop/node_modules/x/index.js',
    'wp-content/themes/shop/old/wp-config.php',
    'wp-content/plugins/backup/site.sql',
    'wp-content/plugins/x/.env',
    'wp-content/themes/shop/debug.log',
    // Dumps and secrets whatever the letter case a hosting gave them.
    'wp-content/plugins/backup/BACKUP.SQL',
    'wp-content/themes/shop/Dump.ZIP',
    'wp-content/plugins/x/.ENV',
    'wp-content/themes/shop/ID_RSA',
    'wp-content/themes/shop/debug.LOG',
    'WP-CONFIG.PHP.BAK',
    'cgi-bin/script.pl',
    'old-site/index.html',
  ])('keeps %s out of the sandbox', (path) => {
    expect(inSet(path)).toBe(false)
  })

  it('protects every platform file it leaves out', () => {
    const protectedPaths = wordpressAdapter.protectedPaths(site)
    expect(isForbiddenPath('wp-config.php', protectedPaths)).toBe(true)
    expect(isForbiddenPath('wp-content/mu-plugins/raditi-content.php', protectedPaths)).toBe(true)
    expect(isForbiddenPath('wp-content/mu-plugins/raditi-preview.php', protectedPaths)).toBe(true)
  })

  it('returns a copy each time', () => {
    wordpressAdapter.agentWorkingSet(site).include.length = 0
    expect(wordpressAdapter.agentWorkingSet(site).include.length).toBeGreaterThan(0)
  })
})

describe('the WordPress media rules (plan 53, Р12)', () => {
  const rules = mediaRulesSchema.parse(wordpressAdapter.mediaRules(site))
  const { media, addOnlyPaths } = siteWorkspaceRules(wordpressAdapter, site)
  const bytes = (hex: string, at = 0) => {
    const out = new Uint8Array(32)
    out.set(Uint8Array.from(Buffer.from(hex, 'hex')), at)
    return out
  }

  it('opens only its own folder of the media library, which stays protected otherwise', () => {
    expect(rules.addOnlyPaths).toEqual(['wp-content/uploads/raditi/'])
    expect(addOnlyPathOf('wp-content/uploads/raditi/a.png', addOnlyPaths)).toBe(
      'wp-content/uploads/raditi/',
    )
    expect(addOnlyPathOf('wp-content/uploads/2026/a.png', addOnlyPaths)).toBeUndefined()
    expect(
      isForbiddenPath('wp-content/uploads/2026/a.png', wordpressAdapter.protectedPaths(site)),
    ).toBe(true)
  })

  it.each([
    ['photo.jpg', 'ffd8ffe0'],
    ['photo.JPEG', 'ffd8ffe1'],
    ['logo.png', '89504e470d0a1a0a'],
    ['anim.gif', '474946383961'],
    ['old.gif', '474946383761'],
    ['font.woff2', '774f4632'],
    ['doc.pdf', '255044462d312e37'],
    ['clip.webm', '1a45dfa3'],
  ])('takes %s', (name, hex) => {
    expect(mediaNameProblem(name, media)).toBeNull()
    expect(mediaContentProblem(name, bytes(hex), media)).toBeNull()
  })

  it('takes WebP, AVIF and MP4 by their containers', () => {
    const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')
    const avif = new TextEncoder().encode('\0\0\0\x1cftypavif')
    const mp4 = new TextEncoder().encode('\0\0\0\x18ftypisom')
    expect(mediaContentProblem('a.webp', webp, media)).toBeNull()
    expect(mediaContentProblem('a.avif', avif, media)).toBeNull()
    expect(mediaContentProblem('a.mp4', mp4, media)).toBeNull()
    expect(mediaContentProblem('a.avif', mp4, media)).toBe('signature')
  })

  it.each([
    ['shell.php', 'refused_name'],
    ['shell.php.jpg', 'refused_name'],
    ['a.phtml', 'refused_name'],
    ['a.phar', 'refused_name'],
    ['.htaccess', 'hidden'],
    ['dir/.user.ini', 'hidden'],
    ['logo.svg', 'refused_name'],
    ['logo.SVGZ', 'refused_name'],
    ['page.html', 'extension'],
    ['script.js', 'extension'],
    ['noext', 'extension'],
  ])('refuses %s', (name, problem) => {
    expect(mediaNameProblem(name, media)).toBe(problem)
  })

  it('refuses a picture whose bytes are not one and a file over 8 MiB', () => {
    const php = new TextEncoder().encode('<?php system($_GET["c"]);')
    expect(mediaContentProblem('a.jpg', php, media)).toBe('signature')
    const page = new TextEncoder().encode('<html><script>alert(1)</script>')
    expect(mediaContentProblem('a.gif', page, media)).toBe('signature')
    const big = new Uint8Array(8 * 1024 * 1024 + 1)
    big.set([0xff, 0xd8, 0xff])
    expect(mediaContentProblem('a.jpg', big, media)).toBe('size')
  })
})
