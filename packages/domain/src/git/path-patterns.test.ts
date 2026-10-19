import { describe, expect, it } from 'vitest'

import { compilePathPattern, compilePathPatterns, pathPatternProblem } from './path-patterns.ts'

const matches = (pattern: string, path: string) => compilePathPattern(pattern)(path)

describe('working-set path patterns', () => {
  it.each([
    ['/wp-content/themes/', 'wp-content/themes/shop/style.css', true],
    ['/wp-content/themes/', 'wp-content/themes', false],
    ['/wp-content/themes/', 'wp-content/themes-old/a.php', false],
    ['/wp-content/themes/', 'x/wp-content/themes/a.php', false],
    // An inner slash anchors like a leading one.
    ['wp-content/themes/', 'wp-content/themes/a.php', true],
    ['wp-content/themes/', 'x/wp-content/themes/a.php', false],
  ])('a directory pattern %s takes %s: %s', (pattern, path, expected) => {
    expect(matches(pattern, path)).toBe(expected)
  })

  it('takes only root files with /*, never a folder there', () => {
    expect(matches('/*', 'robots.txt')).toBe(true)
    expect(matches('/*', '.htaccess')).toBe(true)
    expect(matches('/*', 'wp-admin/index.php')).toBe(false)
    expect(matches('/*', 'cgi-bin/x')).toBe(false)
  })

  it('matches a name without a slash at any depth', () => {
    expect(matches('*.sql', 'dump.sql')).toBe(true)
    expect(matches('*.sql', 'wp-content/plugins/x/dump.sql')).toBe(true)
    expect(matches('*.sql', 'dump.sql.txt')).toBe(false)
    expect(matches('.env.*', 'a/.env.local')).toBe(true)
    expect(matches('id_rsa*', 'a/b/id_rsa.pub')).toBe(true)
  })

  it('matches a folder name with a trailing slash anywhere on the way', () => {
    expect(matches('node_modules/', 'node_modules/a.js')).toBe(true)
    expect(matches('node_modules/', 'wp-content/themes/x/node_modules/y/z.js')).toBe(true)
    expect(matches('node_modules/', 'wp-content/themes/x/node_modules')).toBe(false)
    expect(matches('.ssh/', 'home/.ssh/id_ed25519')).toBe(true)
  })

  it('keeps * and ? within one part and lets ** cross parts', () => {
    expect(matches('/wp-*.php', 'wp-login.php')).toBe(true)
    expect(matches('/wp-*.php', 'wp-content/x.php')).toBe(false)
    expect(matches('/a/?.txt', 'a/b.txt')).toBe(true)
    expect(matches('/a/?.txt', 'a/bc.txt')).toBe(false)
    expect(matches('/a/**/b.txt', 'a/b.txt')).toBe(true)
    expect(matches('/a/**/b.txt', 'a/x/y/b.txt')).toBe(true)
    expect(matches('/a/**', 'a/x/y')).toBe(true)
    expect(matches('/a/**', 'a')).toBe(false)
    expect(matches('**/cache/x', 'cache/x')).toBe(true)
    expect(matches('**/cache/x', 'p/q/cache/x')).toBe(true)
  })

  it('takes regular-expression characters literally and counts letter case', () => {
    expect(matches('/a+b(c).txt', 'a+b(c).txt')).toBe(true)
    expect(matches('/a.b', 'axb')).toBe(false)
    expect(matches('/Readme.md', 'readme.md')).toBe(false)
  })

  it.each(['', '!/x', '/a/[ab]', 'a\\b', '/a//b', '/a/../b', '/./a', '/a**', 'a/x**y', '**', '/'])(
    'refuses %j',
    (pattern) => {
      expect(pathPatternProblem(pattern)).not.toBeNull()
      expect(() => compilePathPattern(pattern)).toThrow()
    },
  )

  it('ignores letter case only when asked', () => {
    const anyCase = compilePathPattern('*.sql', { ignoreCase: true })
    expect(anyCase('wp-content/themes/x/BACKUP.SQL')).toBe(true)
    expect(compilePathPattern('*.sql')('BACKUP.SQL')).toBe(false)
    expect(compilePathPatterns(['/wp-*.php'], { ignoreCase: true })('WP-LOGIN.PHP')).toBe(true)
  })

  it('takes a list as any of its patterns', () => {
    const test = compilePathPatterns(['/a/', '*.txt'])
    expect(test('a/x.php')).toBe(true)
    expect(test('b/x.txt')).toBe(true)
    expect(test('b/x.php')).toBe(false)
    expect(compilePathPatterns([])('a')).toBe(false)
  })
})
