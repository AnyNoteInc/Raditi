import { describe, expect, it } from 'vitest'
import { forbiddenCiPaths, isForbiddenPath, normalizeRepoPath } from './diff-paths.ts'

const wordpressProtected = ['wp-config.php', 'wp-admin/', 'wp-includes/', '/wp-content/uploads/']

describe('isForbiddenPath', () => {
  it.each([
    '.github/workflows/x.yml',
    './.gitlab-ci.yml',
    '/.gitea/workflows/deploy.yml',
    '.gitea',
    '.woodpecker.yml',
    '.woodpecker/pipeline.yml',
    '.drone.yml',
    'Jenkinsfile',
    '.circleci/config.yml',
    '.gitmodules',
    'bitbucket-pipelines.yml',
    '.forgejo/workflows/x.yml',
    '.gitlab/ci/x.yml',
  ])('forbids CI path %s', (path) => {
    expect(isForbiddenPath(path)).toBe(true)
  })

  it('covers every entry of forbiddenCiPaths', () => {
    for (const pattern of forbiddenCiPaths) {
      expect(isForbiddenPath(pattern.replace('*', '.yml'))).toBe(true)
    }
  })

  it.each([
    'src/app.php',
    'wp-content/themes/shop/front-page.php',
    'docs/.github/readme.md',
    '.githubx/file',
    'wp-content/themes/shop/.gitlab-ci.yml',
  ])('allows %s', (path) => {
    expect(isForbiddenPath(path, wordpressProtected)).toBe(false)
  })

  it('applies the extra protected paths of the site adapter', () => {
    expect(isForbiddenPath('wp-config.php', wordpressProtected)).toBe(true)
    expect(isForbiddenPath('wp-config.php')).toBe(false)
    expect(isForbiddenPath('wp-admin/index.php', wordpressProtected)).toBe(true)
    expect(isForbiddenPath('wp-admin', wordpressProtected)).toBe(true)
    expect(isForbiddenPath('wp-admin-custom.php', wordpressProtected)).toBe(false)
    expect(isForbiddenPath('wp-content/uploads/2026/09/a.jpg', wordpressProtected)).toBe(true)
    expect(isForbiddenPath('bitrix/php_interface/dbconn.php', ['/bitrix/'])).toBe(true)
  })

  it('ignores case and redundant separators', () => {
    expect(isForbiddenPath('WP-CONFIG.PHP', wordpressProtected)).toBe(true)
    expect(isForbiddenPath('.GitHub/Workflows/x.yml')).toBe(true)
    expect(isForbiddenPath('.github//workflows/./x.yml')).toBe(true)
    expect(isForbiddenPath('.\\.github\\workflows\\x.yml')).toBe(true)
  })

  it('treats a wildcard as one path segment', () => {
    const protectedPaths = ['wp-content/themes/*/functions.php', 'wp-*.php']
    expect(isForbiddenPath('wp-content/themes/shop/functions.php', protectedPaths)).toBe(true)
    expect(isForbiddenPath('wp-content/themes/shop/inc/functions.php', protectedPaths)).toBe(false)
    expect(isForbiddenPath('wp-login.php', protectedPaths)).toBe(true)
    expect(isForbiddenPath('wp-content/index.php', protectedPaths)).toBe(false)
  })

  it.each(['../x', 'wp-content/../wp-config.php', 'a/..', '', '/', './', 'a\0b'])(
    'forbids the untrustworthy path %j',
    (path) => {
      expect(isForbiddenPath(path)).toBe(true)
    },
  )

  it('refuses an invalid protected pattern instead of ignoring it', () => {
    expect(() => isForbiddenPath('src/app.php', ['../'])).toThrow(/Invalid protected path/)
    expect(() => isForbiddenPath('src/app.php', ['/'])).toThrow(/Invalid protected path/)
  })
})

describe('normalizeRepoPath', () => {
  it('normalises leading ./ and /, backslashes and empty segments', () => {
    expect(normalizeRepoPath('./a//b/./c')).toBe('a/b/c')
    expect(normalizeRepoPath('/a\\b')).toBe('a/b')
    expect(normalizeRepoPath('a/b/')).toBe('a/b')
  })

  it('returns null for traversal, NUL and empty paths', () => {
    expect(normalizeRepoPath('a/../b')).toBeNull()
    expect(normalizeRepoPath('a\0')).toBeNull()
    expect(normalizeRepoPath('./')).toBeNull()
  })
})
