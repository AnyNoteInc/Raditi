import { readFileSync } from 'node:fs'
import { compareSiteVersions, generationOf, isNestedSiteRoot } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { administratorNames, publicFolderNames, root310Names, root620Names } from './fixtures.ts'
import { JOOMLA_ROOT_MARKERS } from './joomla-recognition.ts'
import { joomlaGenerations, joomlaSupport } from './joomla-support.ts'

/** The PHP of the images (Т19), read from the file the images are built from. */
const imageVersions: readonly string[] = (
  JSON.parse(
    readFileSync(new URL('../../../../infra/preview/site-bases.json', import.meta.url), 'utf8'),
  ) as { versions: { php: string }[] }
).versions.map((image) => image.php)

describe('joomlaSupport', () => {
  it('starts each branch from the PHP of the table of the first choice (Т18)', () => {
    expect(Object.fromEntries(joomlaGenerations.map((row) => [row.id, row.php[0]]))).toEqual({
      j30: '7.4',
      j3: '7.4',
      j4: '8.1',
      j5: '8.3',
      j6: '8.3',
    })
  })

  it('tries only the PHP the images have (Т19), each once, and every image of the eight', () => {
    expect(imageVersions).toHaveLength(8)
    for (const row of joomlaGenerations) {
      expect(
        row.php.every((php) => imageVersions.includes(php)),
        row.id,
      ).toBe(true)
      expect(new Set(row.php).size, row.id).toBe(row.php.length)
    }
    const tried = new Set(joomlaGenerations.flatMap((row) => row.php))
    expect([...tried].sort(compareSiteVersions)).toEqual(
      [...imageVersions].sort(compareSiteVersions),
    )
  })

  it('tries the rest in the order of the contract (joomla.md §11.2 without the first choice)', () => {
    expect(Object.fromEntries(joomlaGenerations.map((row) => [row.id, row.php]))).toEqual({
      j30: ['7.4'],
      j3: ['7.4', '7.3', '8.0'],
      j4: ['8.1', '8.2', '8.0', '7.4'],
      j5: ['8.3', '8.2', '8.1'],
      j6: ['8.3', '8.4', '8.5'],
    })
  })

  it('closes the panel of j30 only: Joomla below 3.9 is a branch of the second wave', () => {
    expect(joomlaGenerations.filter((row) => !row.browser).map((row) => row.id)).toEqual(['j30'])
  })

  it.each([
    ['3.17.0', 'j3'],
    ['3.8.1', 'j30'],
    ['3.9.0', 'j3'],
    ['3.10.12', 'j3'],
    ['4.4.14', 'j4'],
    ['5.4.10', 'j5'],
    ['6.2.0', 'j6'],
  ])('puts %s into %s', (version, id) => {
    expect(generationOf(joomlaSupport, version)?.id).toBe(id)
  })

  it('has branches that do not overlap', () => {
    const rows = [...joomlaGenerations].sort((a, b) => compareSiteVersions(a.from, b.from))
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1]
      const row = rows[i]
      if (previous === undefined || row === undefined) continue
      expect(compareSiteVersions(previous.to, row.from), row.id).toBeLessThan(0)
    }
  })

  it('opens the files from 3.9: the number the text of version_unsupported says', () => {
    const open = joomlaGenerations.find((row) => row.files !== 'off')
    expect(open?.from).toBe('3.9')
    expect(joomlaGenerations.filter((row) => row.files === 'off').map((row) => row.id)).toEqual([
      'j30',
    ])
  })

  it('refuses below 3.0, closes an unknown version and wants the checks before a release', () => {
    expect(joomlaSupport).toMatchObject({
      files: 'dev',
      browser: 'off',
      refuseBelow: '3.0',
      releaseNeedsChecks: true,
      unknownVersion: 'closed',
    })
    expect(joomlaGenerations[0]?.from).toBe(joomlaSupport.refuseBelow)
  })

  it('marks the branches the vendor no longer supports', () => {
    expect(joomlaGenerations.filter((row) => row.ended).map((row) => row.id)).toEqual([
      'j30',
      'j3',
      'j4',
    ])
  })
})

describe('JOOMLA_ROOT_MARKERS', () => {
  it('passes a root of 3.10 and of 6.2 and not the folder administrator/ (Т15)', () => {
    expect(isNestedSiteRoot(administratorNames, JOOMLA_ROOT_MARKERS)).toBe(false)
    expect(isNestedSiteRoot(root310Names, JOOMLA_ROOT_MARKERS)).toBe(true)
    expect(isNestedSiteRoot(root620Names, JOOMLA_ROOT_MARKERS)).toBe(true)
  })

  it('does not pass the public folder of 5.0+: rootHint tells it', () => {
    expect(isNestedSiteRoot(publicFolderNames, JOOMLA_ROOT_MARKERS)).toBe(false)
  })
})
