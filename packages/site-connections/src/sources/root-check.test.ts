import { describe, expect, it } from 'vitest'

import {
  FileSourceGuardError,
  SiteConnectionError,
  siteConnectionLimits,
  type FileSourceEntry,
} from '@repo/domain'

import {
  CHECK_READ_BYTES,
  inspectRoot,
  isSafeRef,
  joinRootPath,
  type CheckBrowser,
} from './root-check.ts'

const MARKERS = ['wp-content', 'wp-includes']

const dir = (name: string): FileSourceEntry => ({ name, ref: name, type: 'directory', size: 0 })
const file = (name: string, size: number): FileSourceEntry => ({
  name,
  ref: name,
  type: 'file',
  size,
})

/** A browser over a map of directory → entries (or the error a listing of it throws). */
function browser(tree: Record<string, FileSourceEntry[] | Error>, bytesPerListing = 100) {
  const listed: string[] = []
  const read: string[] = []
  const budgets: number[] = []
  const fake: CheckBrowser = {
    async list(directory, maxBytes) {
      const key = directory.join('/')
      listed.push(key)
      budgets.push(maxBytes)
      const entries = tree[key]
      if (entries instanceof Error) throw entries
      if (!entries) throw new SiteConnectionError('not_found')
      return { entries, bytes: bytesPerListing }
    },
    async readHead(path, bytes) {
      read.push(`${path.join('/')}:${bytes}`)
    },
    typedSegment: (entry) => (entry.name.startsWith('raw-') ? null : entry.name),
  }
  return { fake, listed, read, budgets }
}

describe('inspectRoot', () => {
  it('passes a root with the markers and reads 4 KiB of its smallest file', async () => {
    const { fake, read } = browser({
      '': [
        dir('wp-content'),
        dir('wp-includes'),
        file('index.php', 400),
        file('empty.txt', 0),
        file('big', 10_000),
      ],
    })
    expect(await inspectRoot(fake, '/site', MARKERS)).toEqual({ ok: true, entries: 5 })
    expect(read).toEqual([`index.php:${CHECK_READ_BYTES}`])
  })

  it('matches markers in any letter case, and reads a file of a marker folder where the root has none', async () => {
    const link: FileSourceEntry = { name: 'index.php', ref: 'index.php', type: 'link', size: 30 }
    const { fake, listed, read } = browser({
      '': [dir('WP-Content'), dir('wp-includes'), link],
      'WP-Content': [dir('themes'), file('index.php', 28), file('empty.txt', 0)],
    })
    expect(await inspectRoot(fake, '/', MARKERS)).toEqual({ ok: true, entries: 3 })
    expect(listed).toEqual(['', 'WP-Content'])
    expect(read).toEqual([`WP-Content/index.php:${CHECK_READ_BYTES}`])
  })

  it('passes over a marker folder without a file or that cannot be entered, in the order of the markers', async () => {
    const { fake, listed, read } = browser({
      '': [dir('wp-includes'), dir('wp-content')],
      'wp-content': new SiteConnectionError('access_denied'),
      'wp-includes': [dir('js'), file('version.php', 40)],
    })
    expect(await inspectRoot(fake, '/', MARKERS)).toEqual({ ok: true, entries: 2 })
    expect(listed).toEqual(['', 'wp-content', 'wp-includes'])
    expect(read).toEqual([`wp-includes/version.php:${CHECK_READ_BYTES}`])

    const outside = browser({
      '': [dir('wp-content'), dir('wp-includes')],
      'wp-content': new FileSourceGuardError('outside_root'),
      'wp-includes': [dir('js')],
    })
    await expect(inspectRoot(outside.fake, '/', MARKERS)).rejects.toMatchObject({
      reason: 'transfer_failed',
    })
    expect(outside.read).toEqual([])
  })

  it('fails transfer_failed, never passes, when no file can be read at all', async () => {
    const trees: Record<string, FileSourceEntry[] | Error>[] = [
      { '': [dir('wp-content'), dir('wp-includes')], 'wp-content': [], 'wp-includes': [] },
      {
        '': [dir('wp-content'), dir('wp-includes')],
        'wp-content': new FileSourceGuardError('listing'),
      },
      { '': [] },
    ]
    for (const [index, tree] of trees.entries()) {
      const { fake, read } = browser(tree)
      await expect(inspectRoot(fake, '/', index < 2 ? MARKERS : [])).rejects.toMatchObject({
        reason: 'transfer_failed',
      })
      expect(read).toEqual([])
    }
    // A broken connection while a marker folder lists is that failure, not a missing file.
    const broken = browser({
      '': [dir('wp-content'), dir('wp-includes')],
      'wp-content': new SiteConnectionError('unreachable'),
    })
    await expect(inspectRoot(broken.fake, '/', MARKERS)).rejects.toMatchObject({
      reason: 'unreachable',
    })
  })

  it('suggests the likely folder first, skipping what cannot be entered', async () => {
    const site = [dir('wp-content'), dir('wp-includes')]
    const { fake, listed } = browser({
      '': [dir('aaa'), dir('www'), dir('public_html'), dir('raw-site'), file('wp-content', 1)],
      public_html: new FileSourceGuardError('outside_root'),
      www: new SiteConnectionError('access_denied'),
      aaa: site,
      'raw-site': site,
    })
    expect(await inspectRoot(fake, '/home/u/', MARKERS)).toEqual({
      ok: false,
      reason: 'not_site_root',
      suggestedRoot: '/home/u/aaa',
    })
    expect(listed).toEqual(['', 'public_html', 'www', 'aaa'])
  })

  it('looks at no more than rootSuggestionDirectories folders and spends one byte budget', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `d${String(index).padStart(2, '0')}`)
    const tree: Record<string, FileSourceEntry[]> = { '': names.map(dir) }
    for (const name of names) tree[name] = [file('x', 1)]
    const { fake, listed, budgets } = browser(tree, 1_000)
    expect(await inspectRoot(fake, 'www', MARKERS)).toEqual({ ok: false, reason: 'not_site_root' })
    expect(listed.length).toBe(1 + siteConnectionLimits.rootSuggestionDirectories)
    expect(budgets[0]).toBe(siteConnectionLimits.checkListingBytes)
    expect(budgets[1]).toBe(siteConnectionLimits.checkListingBytes - 1_000)
  })

  it('stops the search when the budget is gone, and fails with a broken connection', async () => {
    const tight = browser({ '': [dir('a'), dir('b')], a: new FileSourceGuardError('listing') })
    expect(await inspectRoot(tight.fake, '/', MARKERS)).toEqual({
      ok: false,
      reason: 'not_site_root',
    })
    expect(tight.listed).toEqual(['', 'a'])

    const broken = browser({ '': [dir('a')], a: new SiteConnectionError('transfer_failed') })
    await expect(inspectRoot(broken.fake, '/', MARKERS)).rejects.toMatchObject({
      reason: 'transfer_failed',
    })
  })

  it('needs no marker when the platform names none', async () => {
    const { fake } = browser({ '': [file('index.html', 10)] })
    expect(await inspectRoot(fake, '/', [])).toEqual({ ok: true, entries: 1 })
  })
})

describe('joinRootPath and isSafeRef', () => {
  it('joins the folder as typed', () => {
    expect(joinRootPath('/', 'public_html')).toBe('/public_html')
    expect(joinRootPath('//', 'x')).toBe('/x')
    expect(joinRootPath('www/', 'site')).toBe('www/site')
    expect(joinRootPath('.', 'site')).toBe('./site')
    expect(joinRootPath('/a', 'x'.repeat(1030))).toBeNull()
  })

  it('takes one segment of a listing and nothing that is a path', () => {
    for (const ref of ['index.php', ' lead', 'Привет', 'a..b']) expect(isSafeRef(ref)).toBe(true)
    for (const ref of ['', '.', '..', 'a/b', 'a\u0000b', 'a\nb', 'a\rb'])
      expect(isSafeRef(ref)).toBe(false)
  })
})
