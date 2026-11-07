import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closedStackRoots,
  FileSourceGuardError,
  importPolicyOf,
  SiteConnectionError,
  siteImportLimits,
  siteReadBytes,
  siteReadEntries,
} from '@repo/domain'
import { getSiteAdapter, siteAdapters } from '@repo/site-adapters'
import { afterEach, describe, expect, it } from 'vitest'

import { directory, fakeSession, file, type FakeNode } from '../testing/file-source.ts'
import { ExactValues } from './exact-values.ts'
import {
  readRootFile,
  siteTreeOf,
  takenFilesRead,
  walkSiteTree,
  type WalkInput,
} from './tree-walk.ts'

const wordpress = getSiteAdapter('wordpress')
const policy = importPolicyOf(
  wordpress.importRules({
    stack: 'wordpress',
    url: 'https://site.example.test',
    docroot: '/',
    extras: {},
  }),
)
const markers = wordpress.rootMarkers()
const closedRoots = closedStackRoots(siteAdapters())
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function walk(
  tree: Record<string, FakeNode>,
  extra: Partial<WalkInput> & { concurrency?: number; values?: ExactValues } = {},
) {
  const blobs = await mkdtemp(join(tmpdir(), 'raditi-walk-test-'))
  roots.push(blobs)
  const session = fakeSession(tree, { concurrency: extra.concurrency ?? 2, delayMs: 1 })
  let work = 0
  const result = walkSiteTree({
    session,
    policy,
    markers,
    closedRoots,
    blobs,
    values: extra.values ?? new ExactValues([]),
    signal: new AbortController().signal,
    onWork: (done) => {
      work += done
    },
    ...extra,
  })
  return { result, session, blobs, work: () => work }
}

const site = (extra: Record<string, FakeNode> = {}): Record<string, FakeNode> => ({
  'index.php': file('<?php require "wp-blog-header.php";\n'),
  'wp-config.php': file("<?php define('DB_PASSWORD', 'synthetic');\n"),
  'wp-includes': directory({ 'version.php': file('<?php $wp_version = "6.8";\n') }),
  'wp-content': directory({
    themes: directory({ site: directory({ 'style.css': file('body{}\n') }) }),
    uploads: directory({
      '2026': directory({ 'photo.jpg': file(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])) }),
    }),
    cache: directory({ 'page.html': file('cached\n') }),
  }),
  ...extra,
})

describe('walkSiteTree', () => {
  it('downloads what the import takes into numbered private copies, core and media included', async () => {
    const { result, blobs, work } = await walk(site())
    const { files, bytes, skipped } = await result

    expect(files.map((taken) => taken.path).sort()).toEqual([
      'index.php',
      'wp-content/themes/site/style.css',
      'wp-content/uploads/2026/photo.jpg',
      'wp-includes/version.php',
    ])
    // wp-config.php and the cache are left out by the rules of the stack.
    expect(skipped).toEqual({ excluded: 2 })
    expect(bytes).toBe(files.reduce((total, taken) => total + taken.bytes, 0))
    // The host never names a copy after a path of the client.
    const names = await readdir(blobs)
    expect(names.every((name) => /^\d+$/.test(name))).toBe(true)
    for (const taken of files) {
      expect(taken.blob.startsWith(`${blobs}/`)).toBe(true)
      expect((await stat(taken.blob)).mode & 0o777).toBe(0o600)
    }
    const photo = files.find((taken) => taken.path.endsWith('photo.jpg'))!
    expect(await readFile(photo.blob)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))
    // Every byte and every listed entry counts for the stall rule.
    expect(work()).toBeGreaterThan(bytes)
  })

  it('counts links, other entries, CI paths, version control and names a repository cannot hold', async () => {
    const { result, session } = await walk(
      site({
        'latest.php': { type: 'link' },
        socket: { type: 'other' },
        '.github': directory({ workflows: directory({ 'deploy.yml': file('on: push\n') }) }),
        '.gitmodules': file('[submodule]\n'),
        '.git': directory({ config: file('[core]\n') }),
        '.svn': directory({ 'wc.db': file('x') }),
        'bad\u0001name.php': file('x'),
        'broken�.php': file('x'),
      }),
    )
    const { skipped } = await result

    expect(skipped).toEqual({
      excluded: 2,
      link: 1,
      unsupported_path: 3,
      ci: 2,
      vcs: 2,
    })
    // Nothing below a skipped folder was listed.
    expect(session.lists.map((path) => path.join('/'))).not.toContain('.git')
    expect(session.lists.map((path) => path.join('/'))).not.toContain('.github')
  })

  it('does not enter another installation below the root', async () => {
    const { result, session } = await walk(
      site({
        old: directory({
          'wp-content': directory({ 'index.php': file('x') }),
          'wp-includes': directory({ 'index.php': file('x') }),
          'index.php': file('x'),
        }),
      }),
    )
    const { files, skipped } = await result

    expect(skipped.nested_site).toBe(1)
    expect(files.some((taken) => taken.path.startsWith('old/'))).toBe(false)
    // Listed once to recognise it, never descended into.
    expect(session.lists.filter((path) => path[0] === 'old')).toEqual([['old']])
  })

  describe('a folder of a stack closed for files', () => {
    // A stack closed for files names its root and its core itself: no literal of it here.
    const bitrix = getSiteAdapter('bitrix')
    const rootNames = bitrix.rootMarkers()
    const coreNames = bitrix.recognition.coreFolder ?? []
    /** A name with a dot is a file of the root, any other a folder. */
    const entriesOf = (names: readonly string[]): Record<string, FakeNode> =>
      Object.fromEntries(
        names.map((name) => [
          name,
          name.includes('.')
            ? file('<?php // synthetic\n')
            : directory({ 'index.php': file('<?php // synthetic\n') }),
        ]),
      )

    it('is not entered when it holds the root of such a stack', async () => {
      const { result, session } = await walk(site({ old: directory(entriesOf(rootNames)) }))
      const { files, skipped } = await result

      expect(skipped.closed_stack).toBe(1)
      expect(files.some((taken) => taken.path.startsWith('old/'))).toBe(false)
      // Listed once to recognise it, never descended into, nothing under it read.
      expect(session.lists.filter((path) => path[0] === 'old')).toEqual([['old']])
      expect(session.reads.filter((path) => path[0] === 'old')).toEqual([])
    })

    it('is not entered when it holds the core of such a stack without the files of its root', async () => {
      expect(coreNames.length).toBeGreaterThan(0)
      const core = directory(entriesOf(coreNames))
      const { result, session } = await walk(site({ backup: directory({ [rootNames[0]!]: core }) }))
      const { files, skipped } = await result

      expect(skipped.closed_stack).toBe(1)
      expect(files.some((taken) => taken.path.startsWith('backup/'))).toBe(false)
      expect(session.lists.filter((path) => path[0] === 'backup')).toEqual([
        ['backup'],
        ['backup', rootNames[0]!],
      ])
    })

    it('counts a folder that is also a root of the own stack as closed, not as another site', async () => {
      const both = { ...entriesOf(rootNames), ...entriesOf(markers) }
      const { result, session } = await walk(site({ old: directory(both) }))
      const { files, skipped } = await result

      expect(skipped.closed_stack).toBe(1)
      expect(skipped.nested_site).toBeUndefined()
      expect(files.some((taken) => taken.path.startsWith('old/'))).toBe(false)
      expect(session.lists.filter((path) => path[0] === 'old')).toEqual([['old']])
    })

    it('imports a folder that has only some of those names', async () => {
      const { result } = await walk(
        site({ lib: directory({ [rootNames[0]!]: directory(entriesOf(coreNames.slice(0, 1))) }) }),
      )
      const { files, skipped } = await result

      expect(skipped.closed_stack).toBeUndefined()
      expect(files.map((taken) => taken.path)).toContain(
        `lib/${rootNames[0]}/${coreNames[0]}/index.php`,
      )
    })
  })

  it('counts a folder the server resolves outside the listed one as a link', async () => {
    const { result } = await walk(site({ mirror: directory({ 'a.php': file('x') }, true) }))
    expect((await result).skipped.link).toBe(1)
  })

  it('leaves out and counts a file over the per-file limit without reading it', async () => {
    const { result, session } = await walk(
      site({ 'big.bin': file('xx', { listedSize: siteImportLimits.fileBytes + 1 }) }),
    )
    expect((await result).skipped.too_large).toBe(1)
    expect(session.reads.map((path) => path.join('/'))).not.toContain('big.bin')
  })

  it.each([
    ['files', { files: 3 }],
    ['bytes of the tree', { treeBytes: 40 }],
    ['directories', { directories: 3 }],
    ['listed entries', { listedEntries: 5 }],
  ] as const)('fails source_too_large past the limit of %s', async (_, limits) => {
    const { result } = await walk(site(), { limits })
    await expect(result).rejects.toMatchObject({ code: 'source_too_large', transient: false })
  })

  it('does not descend below the depth a repository path allows', async () => {
    let tree: Record<string, FakeNode> = { 'deep.php': file('x') }
    for (let level = 0; level < 4; level += 1) tree = { d: directory(tree) }
    const { result } = await walk(tree, { limits: { depth: 2 } })
    const { files, skipped } = await result
    expect(files).toEqual([])
    expect(skipped.unsupported_path).toBe(1)
  })

  it('fails source_inconsistent when a file grows beyond its listed size', async () => {
    const { result, blobs } = await walk(
      site({ 'grows.php': file('0123456789', { listedSize: 4 }) }),
    )
    await expect(result).rejects.toMatchObject({ code: 'source_inconsistent' })
    // The partial copy is gone.
    expect((await readdir(blobs)).length).toBeLessThanOrEqual(4)
  })

  it('fails transfer_failed as a hiccup and a refused login as final', async () => {
    const broken = await walk(site({ 'a.php': file('x', { fails: 'transfer_failed' }) }))
    await expect(broken.result).rejects.toMatchObject({ code: 'transfer_failed', transient: true })
    const refused = await walk(site({ 'a.php': file('x', { fails: 'auth_failed' }) }))
    await expect(refused.result).rejects.toMatchObject({ code: 'auth_failed', transient: false })
    // Required encryption is the server's answer, as a refused login is.
    const plain = await walk(site({ 'a.php': file('x', { fails: 'tls_required' }) }))
    await expect(plain.result).rejects.toMatchObject({ code: 'tls_required', transient: false })
  })

  it('leaves out and counts a folder or a file the server refuses to open or no longer has', async () => {
    const { result, session } = await walk(
      site({
        private: directory({ 'secret.php': file('x') }, { fails: 'access_denied' }),
        moved: directory({ 'a.php': file('x') }, { fails: 'not_found' }),
        'locked.php': file('x', { fails: 'access_denied' }),
        'gone.php': file('partial', { fails: 'not_found' }),
      }),
    )
    const { files, skipped, bytes } = await result
    expect(skipped).toEqual({ excluded: 2, unreadable: 4 })
    const paths = files.map((taken) => taken.path)
    expect(paths).not.toContain('locked.php')
    expect(paths).not.toContain('gone.php')
    expect(paths).toContain('index.php')
    expect(paths.some((path) => path.startsWith('private/'))).toBe(false)
    expect(bytes).toBe(files.reduce((total, taken) => total + taken.bytes, 0))
    // The rest of the walk went on after them.
    expect(session.lists.map((path) => path.join('/'))).toContain('wp-content/themes/site')
  })

  it('fails when the server will not show the root itself', async () => {
    const session = fakeSession(site())
    const list = session.list.bind(session)
    session.list = async (path, maxEntries) => {
      if (path.length === 0) throw new SiteConnectionError('access_denied')
      return list(path, maxEntries)
    }
    const blobs = await mkdtemp(join(tmpdir(), 'raditi-walk-test-'))
    roots.push(blobs)
    await expect(
      walkSiteTree({
        session,
        policy,
        markers,
        closedRoots,
        blobs,
        values: new ExactValues([]),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'access_denied', transient: false })
  })

  it('drops a file that holds an exact secret of the site, even across two chunks', async () => {
    const secret = 'synthetic-db-password-41'
    const values = new ExactValues([secret, ''])
    const { result, blobs } = await walk(
      site({ 'old-config.php': file(`<?php $x = '${secret}';\n`) }),
      { values },
    )
    const { files, skipped } = await result
    expect(skipped.secret).toBe(1)
    expect(files.some((taken) => taken.path === 'old-config.php')).toBe(false)
    for (const name of await readdir(blobs))
      expect((await readFile(join(blobs, name), 'utf8')).includes(secret)).toBe(false)
  })

  it('fails access_value_common when a secret is in more files than one can leave out', async () => {
    const children: Record<string, FakeNode> = {}
    for (let index = 0; index <= siteImportLimits.exactValueFiles; index += 1)
      children[`page-${index}.php`] = file('admin')
    const { result } = await walk(children, { values: new ExactValues(['admin']) })
    await expect(result).rejects.toMatchObject({ code: 'access_value_common' })
  })

  it('reads at most `concurrency` files at once and never lists while reading', async () => {
    const children: Record<string, FakeNode> = {}
    for (let index = 0; index < 12; index += 1) children[`f${index}.php`] = file('x'.repeat(30))
    const { result, session } = await walk(
      { a: directory(children), b: directory(children) },
      { concurrency: 3 },
    )
    expect((await result).files).toHaveLength(24)
    expect(session.peakReads).toBe(3)
    expect(session.listedDuringRead).toBe(false)
  })

  it('stops when its signal aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    const { result } = await walk(site(), { signal: controller.signal })
    await expect(result).rejects.toThrow()
  })
})

describe('readRootFile', () => {
  it('reads a configuration file of the root within its limit, null when absent or larger', async () => {
    const signal = new AbortController().signal
    const session = fakeSession({
      'wp-config.php': file('<?php // synthetic\n'),
      'huge.php': file('x', { listedSize: 1 }),
    })
    expect(Buffer.from((await readRootFile(session, 'wp-config.php', signal))!).toString()).toBe(
      '<?php // synthetic\n',
    )
    expect(await readRootFile(session, 'missing.php', signal)).toBeNull()
    const large = fakeSession({
      'wp-config.php': file('x'.repeat(siteImportLimits.configFileBytes + 1)),
    })
    expect(await readRootFile(large, 'wp-config.php', signal)).toBeNull()
    expect(await readRootFile(session, '../etc/passwd', signal)).toBeNull()
  })
})

describe('takenFilesRead', () => {
  it('reads a file the walk took from its copy, null for one it did not take or a long one', async () => {
    const { result, blobs } = await walk({
      'wp-includes': directory({ 'version.php': file("<?php\n$wp_version = '6.8.3';\n") }),
      'wp-config.php': file('<?php // synthetic\n'),
    })
    const { files } = await result
    // Longer than a SiteRead hands over: never opened, so its copy need not even exist.
    const long = { path: 'big.js', blob: join(blobs, 'absent'), bytes: siteReadBytes + 1 }
    const read = takenFilesRead([...files, long])
    expect(Buffer.from((await read('wp-includes/version.php'))!).toString()).toBe(
      "<?php\n$wp_version = '6.8.3';\n",
    )
    // Left out by the rules of the import: the copy never had it.
    expect(await read('wp-config.php')).toBeNull()
    expect(await read('big.js')).toBeNull()
    expect(await read('missing.php')).toBeNull()
  })
})

describe('siteTreeOf', () => {
  const signal = new AbortController().signal
  const tree = () =>
    fakeSession({
      'index.php': file('<?php // synthetic\n'),
      'wp-includes': directory({ 'version.php': file('<?php $wp_version = "6.8";\n') }),
      locked: directory({ 'a.php': file('x') }, { fails: 'access_denied' }),
      broken: directory({ 'a.php': file('x') }, { fails: 'transfer_failed' }),
      mirror: directory({ 'a.php': file('x') }, true),
      device: { type: 'other' },
      feed: { type: 'link' },
      'cut.php': file('x', { fails: 'transfer_failed' }),
    })

  it('lists the root and a folder by their path, without entries of another kind', async () => {
    const site = siteTreeOf(tree(), signal)
    expect(await site.list('')).toEqual([
      { name: 'index.php', type: 'file' },
      { name: 'wp-includes', type: 'directory' },
      { name: 'locked', type: 'directory' },
      { name: 'broken', type: 'directory' },
      { name: 'mirror', type: 'directory' },
      { name: 'feed', type: 'link' },
      { name: 'cut.php', type: 'file' },
    ])
    expect(await site.list('wp-includes')).toEqual([{ name: 'version.php', type: 'file' }])
  })

  it('asks for at most siteReadEntries entries', async () => {
    const session = tree()
    const asked: number[] = []
    const list = session.list.bind(session)
    session.list = (path, maxEntries) => {
      asked.push(maxEntries)
      return list(path, maxEntries)
    }
    await siteTreeOf(session, signal).list('')
    expect(asked).toEqual([siteReadEntries])
  })

  it('answers null where a folder cannot be listed, never an error', async () => {
    const site = siteTreeOf(tree(), signal)
    expect(await site.list('missing')).toBeNull()
    expect(await site.list('locked')).toBeNull()
    expect(await site.list('broken')).toBeNull()
    // The guards of the session: a folder resolved elsewhere, too many entries.
    expect(await site.list('mirror')).toBeNull()
    const crowded = fakeSession({ many: directory({ a: file('x'), b: file('y') }) })
    const list = crowded.list.bind(crowded)
    crowded.list = (path) => list(path, 1)
    expect(await siteTreeOf(crowded, signal).list('many')).toBeNull()
    // A path the import would not take is never asked for.
    const session = tree()
    for (const path of ['../etc', 'wp-includes/../..', 'a//b', '/abs'])
      expect(await siteTreeOf(session, signal).list(path)).toBeNull()
    expect(session.lists).toEqual([])
  })

  it('reads a file, and answers null where it cannot be read', async () => {
    const site = siteTreeOf(tree(), signal)
    expect(Buffer.from((await site.read('wp-includes/version.php'))!).toString()).toBe(
      '<?php $wp_version = "6.8";\n',
    )
    expect(await site.read('missing.php')).toBeNull()
    expect(await site.read('cut.php')).toBeNull()
    expect(await site.read('../etc/passwd')).toBeNull()
  })

  it('throws once its deadline has passed', async () => {
    const controller = new AbortController()
    controller.abort()
    const site = siteTreeOf(tree(), controller.signal)
    await expect(site.read('index.php')).rejects.toThrow()
    await expect(site.list('')).rejects.toThrow()
  })

  it('lets a guard error of a listing pass as null only, not any other error', async () => {
    const session = tree()
    session.list = async () => {
      throw new FileSourceGuardError('listing')
    }
    expect(await siteTreeOf(session, signal).list('')).toBeNull()

    // Anything else is no answer about the site: it is never read as «no such folder».
    const failing = tree()
    failing.list = async () => {
      throw new Error('synthetic failure')
    }
    await expect(siteTreeOf(failing, signal).list('')).rejects.toThrow('synthetic failure')
  })

  it('throws when the deadline ends a listing or a read midway, rather than answer null', async () => {
    // A session cut by its deadline destroys its sockets: the call fails as a broken transfer.
    const cut = (controller: AbortController) => async () => {
      controller.abort()
      throw new SiteConnectionError('transfer_failed')
    }
    const listing = new AbortController()
    const listed = tree()
    listed.list = cut(listing)
    await expect(siteTreeOf(listed, listing.signal).list('')).rejects.toThrow()

    const reading = new AbortController()
    const read = tree()
    read.read = cut(reading)
    await expect(siteTreeOf(read, reading.signal).read('index.php')).rejects.toThrow()
  })
})
