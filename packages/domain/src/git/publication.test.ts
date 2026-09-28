import { describe, expect, it } from 'vitest'

import { assertPublicationChange, isPublicationPath, publicationLimits } from './publication.ts'

describe('assertPublicationChange', () => {
  const change = (sizeBytes: number) => ({
    path: 'wp-content/uploads/photo.jpg',
    oldMode: '000000',
    newMode: '100644',
    sizeBytes,
  })

  it('accepts a file at the size limit', () => {
    expect(() => assertPublicationChange(change(publicationLimits.fileBytes), [])).not.toThrow()
  })

  it('reports a file over the size limit as too large (413), not as invalid input', () => {
    expect(() => assertPublicationChange(change(publicationLimits.fileBytes + 1), [])).toThrow(
      expect.objectContaining({ code: 'PUBLICATION_TOO_LARGE', httpStatus: 413 }),
    )
  })

  it('reports an impossible size as rejected agent output, not the client input', () => {
    expect(() => assertPublicationChange(change(-1), [])).toThrow(
      expect.objectContaining({ code: 'TURN_OUTPUT_REJECTED', httpStatus: 502 }),
    )
  })

  it.each([
    '-option',
    '.git/config',
    'nested/.GIT/hooks/pre-commit',
    'a/../b',
    'a\\b',
    // Names Git silently drops from the index under core.protectNTFS.
    'git~1/config',
    'GIT~1',
    '.git./config',
    'a/.GIT . /b',
    'git~1.. /x',
    '.git::$INDEX_ALLOCATION/x',
    'a/.git :stream',
  ])('reports the invalid agent path %s as rejected agent output', (path) => {
    expect(isPublicationPath(path)).toBe(false)
    expect(() => assertPublicationChange({ ...change(1), path }, [])).toThrow(
      expect.objectContaining({ code: 'TURN_OUTPUT_REJECTED', httpStatus: 502 }),
    )
  })

  it.each(['.gitignore', '.github.txt', '.git.x/y', 'git~2/u', 'git~1x', 'a/.gitkeep'])(
    'accepts %s, a name Git keeps',
    (path) => {
      expect(isPublicationPath(path)).toBe(true)
    },
  )

  it.each([
    ['a CI path', { path: '.github/workflows/deploy.yml' }],
    ['a protected path', { path: 'wp-config.php' }],
    ['a symlink', { newMode: '120000' }],
    ['a submodule', { newMode: '160000' }],
    ['a permission change', { oldMode: '100644', newMode: '100755' }],
  ])('refuses %s as a forbidden publication, not a missing permission', (_, overrides) => {
    expect(() =>
      assertPublicationChange(
        { ...change(1), oldMode: '100644', newMode: '100644', ...overrides },
        ['wp-config.php'],
      ),
    ).toThrow(expect.objectContaining({ code: 'PUBLICATION_FORBIDDEN', httpStatus: 502 }))
  })
})
