import { describe, expect, it } from 'vitest'

import {
  FileSourceGuardError,
  SiteConnectionError,
  siteConnectionLimits,
  siteReadBytes,
  type FileSourceEntry,
  type SiteRead,
  type SiteRootInspection,
  type SourceCheckContext,
} from '@repo/domain'

import {
  CHECK_READ_BYTES,
  checkSessionRead,
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

const NOTHING: SiteRootInspection = {
  foundStack: null,
  version: { kind: 'unknown' },
  hint: null,
  hasIndexPhp: false,
}

/**
 * A browser over a map of directory → entries (or the error a listing of it throws) and of file →
 * content (or the error a read of it throws). `breaksAfterLongRead`: as one FTP connection, a read
 * past its bound cuts the transfer and every later call fails `transfer_failed`.
 */
function browser(
  tree: Record<string, FileSourceEntry[] | Error>,
  options: {
    bytesPerListing?: number
    files?: Record<string, string | Error>
    breaksAfterLongRead?: boolean
  } = {},
) {
  const { bytesPerListing = 100, files = {}, breaksAfterLongRead = false } = options
  const listed: string[] = []
  const read: string[] = []
  const budgets: number[] = []
  const calls: string[] = []
  let broken = false
  const fake: CheckBrowser = {
    async list(directory, maxBytes) {
      const key = directory.join('/')
      calls.push(`list ${key}`)
      if (broken) throw new SiteConnectionError('transfer_failed')
      listed.push(key)
      budgets.push(maxBytes)
      const entries = tree[key]
      if (entries instanceof Error) throw entries
      if (!entries) throw new SiteConnectionError('not_found')
      return { entries, bytes: bytesPerListing }
    },
    async read(path, sink, maxBytes) {
      const key = path.join('/')
      calls.push(`read ${key}`)
      if (broken) throw new SiteConnectionError('transfer_failed')
      read.push(`${key}:${maxBytes}`)
      const content = files[key] ?? 'x'.repeat(16)
      if (content instanceof Error) throw content
      const bytes = new TextEncoder().encode(content)
      if (bytes.length > maxBytes) {
        if (breaksAfterLongRead) broken = true
        throw new FileSourceGuardError('bytes')
      }
      await sink(bytes.subarray(0, 3))
      await sink(bytes.subarray(3))
      return bytes.length
    },
    typedSegment: (entry) => (entry.name.startsWith('raw-') ? null : entry.name),
  }
  return { fake, listed, read, budgets, calls }
}

/** The context of a check that chose WordPress; `inspect` records its call and may read. */
function checkContext(
  calls: string[] = [],
  inspect: (names: readonly string[], read: SiteRead) => Promise<SiteRootInspection> = async () =>
    NOTHING,
  stacks: SourceCheckContext['stacks'] = [{ stack: 'wordpress', markers: MARKERS }],
): Pick<SourceCheckContext, 'stacks' | 'inspect'> {
  return {
    stacks,
    async inspect(names, read) {
      calls.push(`inspect ${names.join(',')}`)
      return inspect(names, read)
    },
  }
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
    expect(await inspectRoot(fake, '/site', checkContext())).toEqual({
      ok: true,
      entries: 5,
      inspection: NOTHING,
    })
    expect(read).toEqual([`index.php:${CHECK_READ_BYTES}`])
  })

  it('takes a file longer than the bound as a proved read', async () => {
    const { fake, read } = browser(
      { '': [dir('wp-content'), dir('wp-includes'), file('index.php', 40)] },
      { files: { 'index.php': 'y'.repeat(CHECK_READ_BYTES + 1) } },
    )
    expect(await inspectRoot(fake, '/', checkContext())).toMatchObject({ ok: true, entries: 3 })
    expect(read).toEqual([`index.php:${CHECK_READ_BYTES}`])
  })

  it('answers access_denied, never not_found, where a listed file cannot be read', async () => {
    for (const refusal of ['not_found', 'access_denied'] as const) {
      const { fake } = browser(
        { '': [dir('wp-content'), dir('wp-includes'), file('index.php', 40)] },
        { files: { 'index.php': new SiteConnectionError(refusal) } },
      )
      await expect(inspectRoot(fake, '/', checkContext())).rejects.toMatchObject({
        reason: 'access_denied',
      })
    }
    // The same for the file of a marker folder, where the root holds none.
    const { fake } = browser(
      { '': [dir('wp-content'), dir('wp-includes')], 'wp-content': [file('index.php', 20)] },
      { files: { 'wp-content/index.php': new SiteConnectionError('not_found') } },
    )
    await expect(inspectRoot(fake, '/', checkContext())).rejects.toMatchObject({
      reason: 'access_denied',
    })
  })

  it('lets a broken proof read through as it is', async () => {
    const { fake } = browser(
      { '': [dir('wp-content'), dir('wp-includes'), file('index.php', 40)] },
      { files: { 'index.php': new SiteConnectionError('transfer_failed') } },
    )
    await expect(inspectRoot(fake, '/', checkContext())).rejects.toMatchObject({
      reason: 'transfer_failed',
    })
  })

  it('lists, then inspects reading in the same browser, then proves reading, in this order', async () => {
    const { fake, calls } = browser(
      { '': [dir('wp-content'), dir('wp-includes'), file('index.php', 40)] },
      { files: { 'wp-includes/version.php': "<?php $wp_version = '6.9';" } },
    )
    const found: SiteRootInspection = {
      foundStack: 'wordpress',
      version: { kind: 'read', version: '6.9' },
      hint: null,
      hasIndexPhp: true,
    }
    let text: string | null = null
    const context = checkContext(calls, async (_names, read) => {
      const bytes = await read('wp-includes/version.php')
      text = bytes && new TextDecoder().decode(bytes)
      return found
    })
    expect(await inspectRoot(fake, '/', context)).toEqual({
      ok: true,
      entries: 3,
      inspection: found,
    })
    expect(text).toBe("<?php $wp_version = '6.9';")
    expect(calls).toEqual([
      'list ',
      'inspect wp-content,wp-includes,index.php',
      'read wp-includes/version.php',
      'read index.php',
    ])
  })

  it('reads the version on an FTP connection before the read that may cut it', async () => {
    // A long file to prove reading: as one FTP connection, its cut transfer breaks every later call.
    const { fake, calls } = browser(
      { '': [dir('wp-content'), dir('wp-includes'), file('index.php', 40)] },
      {
        files: {
          'index.php': 'y'.repeat(CHECK_READ_BYTES + 1),
          'wp-includes/version.php': "<?php $wp_version = '6.9';",
        },
        breaksAfterLongRead: true,
      },
    )
    const context = checkContext(calls, async (_names, read) => {
      expect(await read('wp-includes/version.php')).not.toBeNull()
      return NOTHING
    })
    expect(await inspectRoot(fake, '/', context)).toMatchObject({ ok: true })
    expect(calls.indexOf('read wp-includes/version.php')).toBeLessThan(
      calls.indexOf('read index.php'),
    )
  })

  it('reads null where the file is gone, closed or too long, and lets a broken read through', async () => {
    const { fake, read } = browser(
      { '': [] },
      {
        files: {
          gone: new SiteConnectionError('not_found'),
          closed: new SiteConnectionError('access_denied'),
          long: 'z'.repeat(siteReadBytes + 1),
          cut: new SiteConnectionError('transfer_failed'),
          'deep/ok.php': 'short',
        },
      },
    )
    const siteRead = checkSessionRead(fake)
    expect(await siteRead('gone')).toBeNull()
    expect(await siteRead('closed')).toBeNull()
    expect(await siteRead('long')).toBeNull()
    expect(new TextDecoder().decode((await siteRead('deep/ok.php'))!)).toBe('short')
    expect(read).toContain(`long:${siteReadBytes}`)
    await expect(siteRead('cut')).rejects.toMatchObject({ reason: 'transfer_failed' })
    // A path the wizard would not import, or not ASCII, is never asked of the server.
    for (const path of ['../etc/passwd', 'a//b', '/abs', 'dir/', 'файл.php', 'a\u0000b'])
      expect(await siteRead(path)).toBeNull()
    expect(read).toHaveLength(5)
  })

  it('fails the check with a read of the version that broke, never passing it as unknown', async () => {
    const { fake, read } = browser(
      { '': [dir('wp-content'), dir('wp-includes'), file('index.php', 40)] },
      { files: { 'wp-includes/version.php': new SiteConnectionError('transfer_failed') } },
    )
    const context = checkContext([], async (_names, siteRead) => {
      await siteRead('wp-includes/version.php')
      return NOTHING
    })
    await expect(inspectRoot(fake, '/', context)).rejects.toMatchObject({
      reason: 'transfer_failed',
    })
    expect(read).toEqual([`wp-includes/version.php:${siteReadBytes}`])
  })

  it('matches markers in any letter case, and reads a file of a marker folder where the root has none', async () => {
    const link: FileSourceEntry = { name: 'index.php', ref: 'index.php', type: 'link', size: 30 }
    const { fake, listed, read } = browser({
      '': [dir('WP-Content'), dir('wp-includes'), link],
      'WP-Content': [dir('themes'), file('index.php', 28), file('empty.txt', 0)],
    })
    expect(await inspectRoot(fake, '/', checkContext())).toMatchObject({ ok: true, entries: 3 })
    expect(listed).toEqual(['', 'WP-Content'])
    expect(read).toEqual([`WP-Content/index.php:${CHECK_READ_BYTES}`])
  })

  it('passes over a marker folder without a file or that cannot be entered, in the order of the markers', async () => {
    const { fake, listed, read } = browser({
      '': [dir('wp-includes'), dir('wp-content')],
      'wp-content': new SiteConnectionError('access_denied'),
      'wp-includes': [dir('js'), file('version.php', 40)],
    })
    expect(await inspectRoot(fake, '/', checkContext())).toMatchObject({ ok: true, entries: 2 })
    expect(listed).toEqual(['', 'wp-content', 'wp-includes'])
    expect(read).toEqual([`wp-includes/version.php:${CHECK_READ_BYTES}`])

    const outside = browser({
      '': [dir('wp-content'), dir('wp-includes')],
      'wp-content': new FileSourceGuardError('outside_root'),
      'wp-includes': [dir('js')],
    })
    await expect(inspectRoot(outside.fake, '/', checkContext())).rejects.toMatchObject({
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
      const stacks = [{ stack: 'wordpress' as const, markers: index < 2 ? MARKERS : [] }]
      await expect(
        inspectRoot(fake, '/', checkContext([], undefined, stacks)),
      ).rejects.toMatchObject({ reason: 'transfer_failed' })
      expect(read).toEqual([])
    }
    // A broken connection while a marker folder lists is that failure, not a missing file.
    const broken = browser({
      '': [dir('wp-content'), dir('wp-includes')],
      'wp-content': new SiteConnectionError('unreachable'),
    })
    await expect(inspectRoot(broken.fake, '/', checkContext())).rejects.toMatchObject({
      reason: 'unreachable',
    })
  })

  it('refuses a root without markers with what the inspection found there, and suggests the likely folder first', async () => {
    const site = [dir('wp-content'), dir('wp-includes')]
    const { fake, listed, read } = browser({
      '': [dir('aaa'), dir('www'), dir('public_html'), dir('raw-site'), file('wp-content', 1)],
      public_html: new FileSourceGuardError('outside_root'),
      www: new SiteConnectionError('access_denied'),
      aaa: site,
      'raw-site': site,
    })
    const foreign = { ...NOTHING, hasIndexPhp: true }
    expect(
      await inspectRoot(
        fake,
        '/home/u/',
        checkContext([], async () => foreign),
      ),
    ).toEqual({
      ok: false,
      reason: 'not_site_root',
      suggestedRoot: '/home/u/aaa',
      inspection: foreign,
    })
    expect(listed).toEqual(['', 'public_html', 'www', 'aaa'])
    expect(read).toEqual([])
  })

  it('takes the markers of any stack it is given, for the root and for the suggestion', async () => {
    const stacks = [
      { stack: 'wordpress' as const, markers: MARKERS },
      { stack: 'bitrix' as const, markers: ['bitrix', '.access.php'] },
    ]
    const root = browser({ '': [dir('bitrix'), file('.access.php', 20)] })
    expect(await inspectRoot(root.fake, '/', checkContext([], undefined, stacks))).toMatchObject({
      ok: true,
      entries: 2,
    })
    const nested = browser({
      '': [dir('www')],
      www: [dir('bitrix'), file('.access.php', 20)],
    })
    expect(await inspectRoot(nested.fake, '/', checkContext([], undefined, stacks))).toEqual({
      ok: false,
      reason: 'not_site_root',
      suggestedRoot: '/www',
      inspection: NOTHING,
    })
    // The chosen stack alone (Р7 of Э2): a folder of Bitrix is no site of WordPress.
    expect(await inspectRoot(root.fake, '/', checkContext())).toMatchObject({
      ok: false,
      reason: 'not_site_root',
    })
  })

  it('looks at no more than rootSuggestionDirectories folders and spends one byte budget', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `d${String(index).padStart(2, '0')}`)
    const tree: Record<string, FileSourceEntry[]> = { '': names.map(dir) }
    for (const name of names) tree[name] = [file('x', 1)]
    const { fake, listed, budgets } = browser(tree, { bytesPerListing: 1_000 })
    expect(await inspectRoot(fake, 'www', checkContext())).toEqual({
      ok: false,
      reason: 'not_site_root',
      inspection: NOTHING,
    })
    expect(listed.length).toBe(1 + siteConnectionLimits.rootSuggestionDirectories)
    expect(budgets[0]).toBe(siteConnectionLimits.checkListingBytes)
    expect(budgets[1]).toBe(siteConnectionLimits.checkListingBytes - 1_000)
  })

  it('stops the search when the budget is gone, and fails with a broken connection', async () => {
    const tight = browser({ '': [dir('a'), dir('b')], a: new FileSourceGuardError('listing') })
    expect(await inspectRoot(tight.fake, '/', checkContext())).toEqual({
      ok: false,
      reason: 'not_site_root',
      inspection: NOTHING,
    })
    expect(tight.listed).toEqual(['', 'a'])

    const broken = browser({ '': [dir('a')], a: new SiteConnectionError('transfer_failed') })
    await expect(inspectRoot(broken.fake, '/', checkContext())).rejects.toMatchObject({
      reason: 'transfer_failed',
    })
  })

  it('needs no marker when the platform names none', async () => {
    const { fake } = browser({ '': [file('index.html', 10)] })
    const stacks = [{ stack: 'wordpress' as const, markers: [] }]
    expect(await inspectRoot(fake, '/', checkContext([], undefined, stacks))).toMatchObject({
      ok: true,
      entries: 1,
    })
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
