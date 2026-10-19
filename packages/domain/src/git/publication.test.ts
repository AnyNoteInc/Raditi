import { describe, expect, it } from 'vitest'

import {
  addOnlyPathOf,
  assertCandidateChange,
  assertCandidateMedia,
  assertCandidatePath,
  assertPublicationChange,
  candidateRulesOf,
  isPublicationPath,
  publicationLimits,
  publicationMetadataSchema,
  type PublicationSource,
} from './publication.ts'

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

describe('the rules of a candidate (plan 53, Р11, Р12)', () => {
  const source: PublicationSource = {
    repo: { provider: 'gitea', owner: 'sites', name: 'site' },
    branch: 'agent/task1',
    expectedBaseSha: 'a'.repeat(40),
    protectedPaths: ['wp-config.php', 'wp-content/uploads/', '**/.htaccess'],
    // The add-only folder is not in the set: the agent adds media there that it does not see.
    workingSet: { include: ['/wp-content/themes/'], exclude: [], maxBytes: 1024 },
    addOnlyPaths: ['wp-content/uploads/raditi/'],
    media: {
      extensions: { png: [{ offset: 0, hex: '89504e47' }] },
      refusedNameParts: ['.php', '.svg'],
      maxFileBytes: 16,
    },
  }
  const rules = candidateRulesOf(source)
  const added = (path: string, sizeBytes = 8, newMode = '100644') => ({
    path,
    oldMode: '000000',
    newMode,
    sizeBytes,
  })
  const forbidden = expect.objectContaining({ code: 'PUBLICATION_FORBIDDEN' })

  it('takes changes inside the working set and new media in its own folder', () => {
    expect(() => assertCandidateChange(added('wp-content/themes/a/x.php'), rules)).not.toThrow()
    expect(() =>
      assertCandidateChange(
        { path: 'wp-content/themes/a/x.php', oldMode: '100644', newMode: '000000', sizeBytes: 0 },
        rules,
      ),
    ).not.toThrow()
    expect(() =>
      assertCandidateChange(added('wp-content/uploads/raditi/a.png'), rules),
    ).not.toThrow()
    expect(() => assertCandidatePath('wp-content/uploads/raditi/a.png', rules)).not.toThrow()
  })

  it('refuses a path outside the working set even when nothing protects it', () => {
    expect(() => assertCandidateChange(added('wp-includes/new.php'), rules)).toThrow(forbidden)
    expect(() => assertCandidatePath('old/index.html', rules)).toThrow(forbidden)
  })

  it('takes new media outside the working set only as media', () => {
    expect(rules.inWorkingSet!('wp-content/uploads/raditi/a.png')).toBe(false)
    expect(() => assertCandidatePath('wp-content/uploads/raditi/x/a.png', rules)).not.toThrow()
    expect(() => assertCandidatePath('wp-content/uploads/raditi/a.php', rules)).toThrow(forbidden)
    expect(() => assertCandidatePath('wp-content/uploads/a.png', rules)).toThrow(forbidden)
  })

  it('keeps media add-only and named as the rules say', () => {
    for (const change of [
      { ...added('wp-content/uploads/raditi/a.png'), oldMode: '100644' },
      { ...added('wp-content/uploads/raditi/a.png'), oldMode: '100644', newMode: '000000' },
      added('wp-content/uploads/raditi/a.png', 8, '100755'),
      added('wp-content/uploads/raditi/a.php.png'),
      added('wp-content/uploads/raditi/.a.png'),
      added('wp-content/uploads/raditi/a.svg'),
      added('wp-content/uploads/raditi/.htaccess'),
    ])
      expect(() => assertCandidateChange(change, rules)).toThrow(forbidden)
    expect(() =>
      assertCandidateChange(added('wp-content/uploads/raditi/a.png', 17), rules),
    ).toThrow(expect.objectContaining({ code: 'PUBLICATION_TOO_LARGE' }))
    // The folder itself is no file in it; another folder of the library stays protected.
    expect(addOnlyPathOf('wp-content/uploads/raditi/', source.addOnlyPaths)).toBeUndefined()
    expect(() => assertCandidateChange(added('wp-content/uploads/2026/a.png'), rules)).toThrow(
      forbidden,
    )
  })

  it('keeps the protected patterns at any depth under the add-only folder (owner, 19.10.2026)', () => {
    // A name the media rules take: only the pattern refuses it, the second line next to them.
    const guarded = candidateRulesOf({
      ...source,
      protectedPaths: [...source.protectedPaths, '**/sitemap.png'],
    })
    for (const path of [
      'wp-content/uploads/raditi/sitemap.png',
      'wp-content/uploads/raditi/a/SITEMAP.png',
    ]) {
      expect(() => assertCandidatePath(path, guarded)).toThrow(forbidden)
      expect(() => assertCandidateChange(added(path), guarded)).toThrow(forbidden)
      expect(() => assertCandidatePath(path, rules)).not.toThrow()
    }
    // The other protected paths still give way: the media library itself is protected.
    expect(() =>
      assertCandidateChange(added('wp-content/uploads/raditi/a.png'), guarded),
    ).not.toThrow()
  })

  it('checks the bytes of added media and leaves other files alone', () => {
    const picture = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1])
    expect(assertCandidateMedia('wp-content/uploads/raditi/a.png', picture, rules)).toBe(true)
    expect(assertCandidateMedia('wp-content/themes/a/x.php', picture, rules)).toBe(false)
    expect(() =>
      assertCandidateMedia(
        'wp-content/uploads/raditi/a.png',
        new TextEncoder().encode('<?php'),
        rules,
      ),
    ).toThrow(forbidden)
  })

  it('keeps the old rules without a working set or media', () => {
    const old = candidateRulesOf({ ...source, workingSet: undefined, addOnlyPaths: undefined })
    expect(old.inWorkingSet).toBeNull()
    expect(() => assertCandidateChange(added('old/index.html'), old)).not.toThrow()
    expect(() => assertCandidateChange(added('wp-content/uploads/raditi/a.png'), old)).toThrow(
      forbidden,
    )
  })

  it('refuses a working-set commit without its set and add-only paths without media checks', () => {
    const metadata = { ...source, taskId: 'task1', turn: 1, createdAt: '2026-10-17T10:00:00.000Z' }
    expect(publicationMetadataSchema.safeParse(metadata).success).toBe(true)
    expect(
      publicationMetadataSchema.safeParse({
        ...metadata,
        workingSet: undefined,
        sandboxBaseSha: 'b'.repeat(40),
      }).success,
    ).toBe(false)
    expect(publicationMetadataSchema.safeParse({ ...metadata, media: undefined }).success).toBe(
      false,
    )
  })
})
