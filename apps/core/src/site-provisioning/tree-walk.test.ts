import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createImportPathPolicy, SiteConnectionError, siteImportLimits } from '@repo/domain'
import { getSiteAdapter } from '@repo/site-adapters'
import { afterEach, describe, expect, it } from 'vitest'

import { directory, fakeSession, file, type FakeNode } from '../testing/file-source.ts'
import { ExactValues } from './exact-values.ts'
import { readRootFile, walkSiteTree, type WalkInput } from './tree-walk.ts'

const wordpress = getSiteAdapter('wordpress')
const policy = createImportPathPolicy(
  wordpress.importRules({
    stack: 'wordpress',
    url: 'https://site.example.test',
    docroot: '/',
    extras: {},
  }).exclude,
)
const markers = wordpress.rootMarkers()
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
