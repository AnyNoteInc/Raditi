import {
  SiteConnectionError,
  type DbContentUpdate,
  type DeployAccess,
  type DeployManifest,
  type DeployWrap,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { sealDbOperationValue } from '../releases/release-db-values.ts'
import {
  contentState,
  FakeCodeCache,
  FakeReleaseApi,
  MemoryContentGateway,
  MemoryHosting,
  sha256Hex,
} from '../testing/deploy-step.ts'
import { openBackup, sealBackup } from './backup.ts'
import { deployLimits, layoutOf, runDeploy, type DeployContext } from './deploy.ts'
import { ReleaseApiError } from './release-api.ts'
import type { SiteCheckResult } from './site-check.ts'
import { TreeSourceError, type TreeSource } from './tree-source.ts'

const releaseId = '0196abcd-0000-7000-8000-00000000000a'
const siteId = '0196abcd-0000-7000-8000-0000000000aa'
const approvedSha = '3f786850e387550fdab836ed7e6dc881de23001b'
const key = Buffer.alloc(32, 7)
const wrap: DeployWrap = {
  releaseId,
  attempt: 1,
  tag: 'v1.4.0',
  sha: approvedSha,
  wrapToken: 'hvs.x1234567',
}

/** What production holds: the installed version. */
const installed = {
  'index.php': '<?php echo "старая главная";\n',
  'wp-content/themes/shop/style.css': 'body{color:black}\n',
  'wp-content/themes/shop/old.css': '.old{}\n',
}
/** What the release commit holds where it differs. */
const approved: Record<string, string> = {
  'index.php': '<?php echo "новая главная";\n',
  'wp-content/themes/shop/new.css': '.new{}\n',
  'wp-content/uploads/raditi/banner.webp': 'RIFF....WEBPVP8 ',
  'bin/cron.sh': '#!/bin/sh\n',
}
const priorPage = contentState('page:42', { title: 'Главная', content: '<p>Привет</p>' })
const nextPage = contentState('page:42', { title: 'Добро пожаловать', content: '<p>Привет</p>' })
const operation: DbContentUpdate = {
  kind: 'content_update',
  objectRef: 'page:42',
  fields: ['title'],
  beforeHash: priorPage.stateHash,
  afterHash: nextPage.stateHash,
  before: { key: 'tasks/t/db/c/before.json', sha256: 'a'.repeat(64), sizeBytes: 10 },
  after: { key: 'tasks/t/db/c/after.json', sha256: 'b'.repeat(64), sizeBytes: 10 },
}
const presigned = {
  method: 'GET' as const,
  url: 'https://s3.example.test/raditi-backups/db/0.bin',
  headers: {},
  expiresAt: '2026-10-17T21:00:00.000Z',
}
const ok: SiteCheckResult = { ok: true, pages: 1, failed: 0 }
const broken: SiteCheckResult = { ok: false, pages: 1, failed: 1 }

function manifestOf(overrides: Partial<DeployManifest> = {}): DeployManifest {
  return {
    v: 1,
    kind: 'release',
    releaseId,
    siteId,
    deployAttempt: 1,
    tag: 'v1.4.0',
    installedSha: 'c'.repeat(40),
    approvedSha,
    method: 'sftp',
    files: {
      write: [
        {
          path: 'index.php',
          before: sha256Hex(installed['index.php']),
          after: sha256Hex(approved['index.php']!),
          sizeBytes: Buffer.byteLength(approved['index.php']!),
          executable: false,
        },
        ...[
          'wp-content/themes/shop/new.css',
          'wp-content/uploads/raditi/banner.webp',
          'bin/cron.sh',
        ].map((path) => ({
          path,
          before: null,
          after: sha256Hex(approved[path]!),
          sizeBytes: Buffer.byteLength(approved[path]!),
          executable: path.endsWith('.sh'),
        })),
      ],
      delete: [
        {
          path: 'wp-content/themes/shop/old.css',
          before: sha256Hex(installed['wp-content/themes/shop/old.css']),
        },
      ],
    },
    db: [{ operation, after: presigned }],
    contentEpoch: 5,
    rollbackOf: null,
    addOnlyPaths: [],
    verify: {
      origin: 'https://shop.example.ru',
      failureMarkers: ['<b>Fatal error</b>:'],
      pages: ['/'],
    },
    ...overrides,
  }
}

/** The files part of a manifest from two versions of the tree: `null` — the path is absent. */
function filesOf(from: Record<string, string>, to: Record<string, string | null>) {
  const write: DeployManifest['files']['write'] = []
  const remove: DeployManifest['files']['delete'] = []
  for (const [path, content] of Object.entries(to)) {
    const before = from[path] ?? null
    if (content === null) remove.push({ path, before: sha256Hex(before!) })
    else
      write.push({
        path,
        before: before === null ? null : sha256Hex(before),
        after: sha256Hex(content),
        sizeBytes: Buffer.byteLength(content),
        executable: false,
      })
  }
  return { write, delete: remove }
}

const access: DeployAccess = {
  v: 1,
  hosting: {
    method: 'sftp',
    access: {
      v: '1',
      host: 'ssh.example.ru',
      port: '22',
      hostKey: `ssh-ed25519 SHA256:${'A'.repeat(43)}`,
      rootPath: '/var/www/shop',
      username: 'shop',
      auth: 'password',
      password: 'password-of-the-hosting',
    },
  },
  content: {
    stack: 'wordpress',
    access: {
      v: '1',
      origin: 'https://shop.example.ru',
      username: 'raditi',
      applicationPassword: 'abcd efgh ijkl mnop qrst uvwx',
    },
  },
}

interface World {
  hosting: MemoryHosting
  gateway: MemoryContentGateway
  api: FakeReleaseApi
  tree: Record<string, string>
  treeReads: string[]
  /** The checks of the site in order: the one before the first write, after it, after the rollback. */
  checks: SiteCheckResult[]
  checked: number
  abort: AbortController
  logs: string[]
  value: Buffer
  clock: { now: number }
  /** Sessions of the hosting the job asked for, the forward one first. */
  sessions: AbortSignal[]
  /** Throws for the n-th session and after (0-based); null — never. */
  refuseSessionsFrom: number | null
}

function world(manifest = manifestOf(), files: Record<string, string> = installed): World {
  const clock = { now: 1_800_000_000_000 }
  const api = new FakeReleaseApi(manifest, access)
  api.now = () => clock.now
  return {
    hosting: new MemoryHosting(files),
    gateway: new MemoryContentGateway(siteId, [priorPage]),
    api,
    tree: { ...approved },
    treeReads: [],
    checks: [],
    checked: 0,
    abort: new AbortController(),
    logs: [],
    value: sealDbOperationValue({ after: nextPage, before: null }, operation, releaseId, key),
    clock,
    sessions: [],
    refuseSessionsFrom: null,
  }
}

function contextOf(w: World): DeployContext {
  const tree: TreeSource = {
    async file(path, expected) {
      w.treeReads.push(path)
      const text = w.tree[path]
      if (text === undefined || sha256Hex(text) !== expected.sha256) throw new TreeSourceError()
      return Buffer.from(text)
    },
  }
  return {
    wrap,
    api: w.api,
    backupKey: key,
    tree,
    openHosting: async (_hosting, signal) => {
      w.sessions.push(signal)
      if (w.refuseSessionsFrom !== null && w.sessions.length > w.refuseSessionsFrom)
        throw new SiteConnectionError('unreachable')
      return w.hosting.session()
    },
    contentGateway: () => w.gateway,
    download: async (request) => {
      if (request.url === presigned.url) return w.value
      throw new Error('Unknown object')
    },
    upload: async (_request, body) => {
      w.api.backup = Buffer.from(body)
    },
    checkSite: async () => {
      const result = w.checks[w.checked] ?? ok
      w.checked += 1
      return result
    },
    log: (line) => w.logs.push(line),
    signal: w.abort.signal,
    now: () => w.clock.now,
    sleep: async (ms) => {
      w.clock.now += ms
    },
  }
}

/** The outcome of a deploy whose last report core took. */
async function deploy(context: DeployContext) {
  const result = await runDeploy(context)
  expect(result.told).toBe(true)
  return result.outcome
}

const deployed = (w: World) => ({
  index: w.hosting.text('index.php'),
  newCss: w.hosting.text('wp-content/themes/shop/new.css'),
  oldCss: w.hosting.text('wp-content/themes/shop/old.css'),
  banner: w.hosting.text('wp-content/uploads/raditi/banner.webp'),
  cron: w.hosting.text('bin/cron.sh'),
  title: w.gateway.records.get('page:42')!.title,
})
const asInstalled = {
  index: installed['index.php'],
  newCss: null,
  oldCss: installed['wp-content/themes/shop/old.css'],
  banner: null,
  cron: null,
  title: 'Главная',
}
/** The folders of the installed version: a rollback leaves none of its own behind. */
const installedFolders = ['wp-content', 'wp-content/themes', 'wp-content/themes/shop']

describe('a deploy attempt (Р30)', () => {
  it('checks, backs up, writes the files and the records, checks the site and reports each step', async () => {
    const w = world()
    expect(await deploy(contextOf(w))).toBe('installed')
    expect(w.api.sequence).toEqual([
      'conflicts started',
      'conflicts succeeded',
      'backup started',
      'backup succeeded',
      'files started',
      'files succeeded',
      'db started',
      'db succeeded',
      'verify started',
      'verify succeeded',
    ])
    // The access is asked for once, after the start is reported (Р29).
    expect(w.api.calls.slice(0, 3)).toEqual(['manifest', 'report conflicts:started', 'access'])
    expect(w.api.accessCalls).toBe(1)
    expect(deployed(w)).toEqual({
      index: approved['index.php'],
      newCss: approved['wp-content/themes/shop/new.css'],
      oldCss: null,
      banner: approved['wp-content/uploads/raditi/banner.webp'],
      cron: approved['bin/cron.sh'],
      title: 'Добро пожаловать',
    })
    // The record is written byte for byte under the release's fence, and its receipt is kept.
    expect(w.gateway.log).toEqual(['release page:42'])
    expect(w.gateway.epoch).toBe(5)
    expect(w.gateway.records.get('page:42')).toEqual(nextPage)
    // Modes: the replaced file keeps its own; a new script is executable; folders made on the way.
    expect(w.hosting.files.get('index.php')!.mode).toBe(0o644)
    expect(w.hosting.files.get('bin/cron.sh')!.mode).toBe(0o755)
    expect(w.hosting.log).toContain('mkdir wp-content/uploads/raditi')
    expect(w.hosting.temporaries).toEqual([])
    expect(w.hosting.closed).toBe(1)
    const counts = w.api.reports.find(
      (report) => report.step === 'files' && report.state === 'succeeded',
    )
    expect(counts?.detail.files).toBe(5)
    // The site was checked before the first write and twice after the last one.
    expect(w.checked).toBe(3)
  })

  it('backs up exactly what it overwrites and deletes, the prior records and the folders it makes', async () => {
    const w = world()
    await deploy(contextOf(w))
    const backup = await openBackup(w.api.backup!, key, releaseId, 1)
    expect(
      Object.fromEntries(
        backup.files.map((file) => [file.path, Buffer.from(file.bytes).toString()]),
      ),
    ).toEqual({
      'index.php': installed['index.php'],
      'wp-content/themes/shop/old.css': installed['wp-content/themes/shop/old.css'],
    })
    expect(backup.records).toEqual([priorPage])
    expect(backup.folders).toEqual(['bin', 'wp-content/uploads', 'wp-content/uploads/raditi'])
    // core verified what it was told: the size and SHA-256 of the sealed archive.
    expect(w.api.backupNamed).toEqual({
      sha256: sha256Hex(w.api.backup!),
      sizeBytes: w.api.backup!.byteLength,
    })
  })

  it('writes nothing to a site that already fails its check', async () => {
    const w = world()
    w.checks = [broken]
    expect(await deploy(contextOf(w))).toBe('failed')
    expect(w.api.sequence).toEqual(['conflicts started', 'conflicts failed site_broken_before'])
    // Not even the access is asked for.
    expect(w.api.accessCalls).toBe(0)
    expect(w.hosting.opened).toBe(0)
    expect(w.hosting.log).toEqual([])
  })

  it('writes nothing when a file on the hosting is not the installed version', async () => {
    const w = world()
    w.hosting.put('index.php', '<?php echo "правка руками";\n')
    expect(await deploy(contextOf(w))).toBe('failed')
    expect(w.api.sequence).toEqual(['conflicts started', 'conflicts failed conflict'])
    expect(w.hosting.log).toEqual([])
    expect(w.gateway.log).toEqual([])
    expect(w.api.backupNamed).toBeNull()
    expect(w.treeReads).toEqual([])
  })

  it('writes nothing when a path it adds is taken or a path it deletes is gone', async () => {
    const taken = world()
    taken.hosting.put('wp-content/themes/shop/new.css', 'someone else’s file')
    expect(await deploy(contextOf(taken))).toBe('failed')
    expect(taken.api.sequence.at(-1)).toBe('conflicts failed conflict')
    expect(taken.hosting.text('wp-content/themes/shop/new.css')).toBe('someone else’s file')

    // A folder it would make is a file now.
    const blocked = world()
    blocked.hosting.put('bin', 'a file named bin')
    expect(await deploy(contextOf(blocked))).toBe('failed')
    expect(blocked.api.sequence.at(-1)).toBe('conflicts failed conflict')

    const gone = world()
    gone.hosting.files.delete('wp-content/themes/shop/old.css')
    expect(await deploy(contextOf(gone))).toBe('failed')
    expect(gone.api.sequence.at(-1)).toBe('conflicts failed conflict')
    expect(gone.hosting.log).toEqual([])
  })

  it('writes nothing when a record on production is not the base of the plan', async () => {
    const w = world()
    w.gateway.records.set(
      'page:42',
      contentState('page:42', { title: 'Изменили в админке', content: '<p>Привет</p>' }),
    )
    expect(await deploy(contextOf(w))).toBe('failed')
    expect(w.api.sequence).toEqual(['conflicts started', 'conflicts failed conflict'])
    expect(w.hosting.log).toEqual([])
  })

  it('treats a link on the way as a conflict, not as a folder', async () => {
    const w = world()
    w.hosting.links.add('wp-content/themes')
    expect(await deploy(contextOf(w))).toBe('failed')
    expect(w.api.sequence.at(-1)).toBe('conflicts failed conflict')
  })

  it('asks for nothing when the manifest is not of the run its secret named', async () => {
    for (const manifest of [
      manifestOf({ tag: 'v1.4.1' }),
      manifestOf({ approvedSha: 'd'.repeat(40) }),
      manifestOf({ deployAttempt: 2 }),
    ]) {
      const w = world(manifest)
      expect(await deploy(contextOf(w))).toBe('failed')
      expect(w.api.sequence).toEqual(['conflicts failed source_mismatch'])
      expect(w.api.accessCalls).toBe(0)
    }
  })

  it('refuses a manifest no commit can describe, or one that changes an add-only folder', async () => {
    const base = manifestOf()
    const index = base.files.write[0]!
    for (const manifest of [
      // A path written and deleted.
      manifestOf({
        files: { ...base.files, delete: [{ path: 'index.php', before: index.before! }] },
      }),
      // A file below another file it writes.
      manifestOf({
        files: {
          ...base.files,
          write: [...base.files.write, { ...index, path: 'index.php/x', before: null }],
        },
      }),
      // Media are only added (Р12): replacing or deleting one is refused.
      manifestOf({
        addOnlyPaths: ['wp-content/themes/'],
      }),
    ]) {
      const w = world(manifest)
      expect(await deploy(contextOf(w))).toBe('failed')
      expect(w.api.sequence).toEqual(['conflicts started', 'conflicts failed source_mismatch'])
      expect(w.api.accessCalls).toBe(0)
      expect(w.hosting.log).toEqual([])
    }
    // Additions to an add-only folder are what it is for.
    const media = world(manifestOf({ addOnlyPaths: ['wp-content/uploads/raditi/'] }))
    expect(await deploy(contextOf(media))).toBe('installed')
  })

  it('writes nothing when a file of the commit or a value is not what the manifest names', async () => {
    const file = world()
    file.tree['wp-content/themes/shop/new.css'] = '.tampered{}\n'
    expect(await deploy(contextOf(file))).toBe('failed')
    expect(file.api.sequence.at(-1)).toBe('conflicts failed source_mismatch')
    expect(file.hosting.log).toEqual([])

    const foreign = world()
    // A value sealed for another release does not open with this one.
    foreign.value = sealDbOperationValue(
      { after: nextPage, before: null },
      operation,
      '0196abcd-0000-7000-8000-00000000000b',
      key,
    )
    expect(await deploy(contextOf(foreign))).toBe('failed')
    expect(foreign.api.sequence.at(-1)).toBe('conflicts failed source_mismatch')

    const other = world()
    // The value opens but does not lead to the state of the plan.
    other.value = sealDbOperationValue(
      {
        after: contentState('page:42', { title: 'Другое', content: '<p>Привет</p>' }),
        before: null,
      },
      operation,
      releaseId,
      key,
    )
    expect(await deploy(contextOf(other))).toBe('failed')
    expect(other.api.sequence.at(-1)).toBe('conflicts failed source_mismatch')
  })

  it('writes nothing when core does not confirm the backup', async () => {
    const w = world()
    const context = contextOf(w)
    context.upload = async () => {}
    expect(await deploy(context)).toBe('failed')
    expect(w.api.sequence.slice(-2)).toEqual(['backup started', 'backup failed backup_refused'])
    expect(w.hosting.log).toEqual([])
  })

  it('stops before the first write when core says so, and reports nothing more', async () => {
    const w = world()
    w.api.answer = (report) => ({
      accepted: true,
      proceed: !(report.step === 'backup' && report.state === 'succeeded'),
    })
    expect(await deploy(contextOf(w))).toBe('failed')
    expect(w.api.sequence.at(-1)).toBe('backup succeeded')
    expect(w.hosting.log).toEqual([])
  })

  it('never overwrites an edit the owner made after the conflicts step', async () => {
    const w = world()
    const context = contextOf(w)
    // While the backup goes up, the owner edits a file the release replaces.
    context.upload = async (_request, body) => {
      w.api.backup = Buffer.from(body)
      w.hosting.put('index.php', '<?php echo "правка владельца";\n')
    }
    expect(await deploy(context)).toBe('rolled_back')
    expect(w.api.sequence).toContain('files failed conflict')
    expect(w.hosting.text('index.php')).toBe('<?php echo "правка владельца";\n')
    // Everything else is as installed, and the owner's edit is not counted against the rollback.
    expect({ ...deployed(w), index: installed['index.php'] }).toEqual(asInstalled)
    expect(w.api.sequence.at(-3)).toBe('rollback succeeded')
  })
})

describe('changes of the layout (Р30)', () => {
  it('turns a file into a folder: the file goes first, its folder goes on rollback', async () => {
    const before = { 'index.php': '<?php\n', lang: 'a file named lang\n' }
    const after = { lang: null, 'lang/ru.json': '{"привет":"мир"}\n' }
    const manifest = manifestOf({ files: filesOf(before, after), db: [] })
    const w = world(manifest, before)
    w.tree = { 'lang/ru.json': after['lang/ru.json'] }
    expect(await deploy(contextOf(w))).toBe('installed')
    expect(w.hosting.text('lang/ru.json')).toBe(after['lang/ru.json'])
    expect(w.hosting.folders.has('lang')).toBe(true)

    const back = world(manifest, before)
    back.tree = w.tree
    back.checks = [ok, broken]
    expect(await deploy(contextOf(back))).toBe('rolled_back')
    expect(back.hosting.text('lang')).toBe(before.lang)
    expect(back.hosting.folders.has('lang')).toBe(false)
    expect(back.hosting.text('lang/ru.json')).toBeNull()
  })

  it('turns a folder into a file: its files go first, then the empty folders', async () => {
    const before = { 'docs/a.txt': 'a\n', 'docs/sub/b.txt': 'b\n' }
    const after = { docs: 'one file now\n', 'docs/a.txt': null, 'docs/sub/b.txt': null }
    const manifest = manifestOf({ files: filesOf(before, after), db: [] })
    const w = world(manifest, before)
    w.tree = { docs: after.docs }
    expect(await deploy(contextOf(w))).toBe('installed')
    expect(w.hosting.text('docs')).toBe(after.docs)
    expect([...w.hosting.folders]).toEqual([])

    const back = world(manifest, before)
    back.tree = w.tree
    back.checks = [ok, broken]
    expect(await deploy(contextOf(back))).toBe('rolled_back')
    expect(back.hosting.text('docs/a.txt')).toBe('a\n')
    expect(back.hosting.text('docs/sub/b.txt')).toBe('b\n')
    expect(back.hosting.files.has('docs')).toBe(false)
  })

  it('stops at a folder that holds what the release does not know, and puts its files back', async () => {
    const before = { 'docs/a.txt': 'a\n' }
    const after = { docs: 'one file now\n', 'docs/a.txt': null }
    const w = world(manifestOf({ files: filesOf(before, after), db: [] }), before)
    w.tree = { docs: after.docs }
    w.hosting.put('docs/cache.tmp', 'made by the site')
    expect(await deploy(contextOf(w))).toBe('rolled_back')
    expect(w.api.sequence).toContain('files failed conflict')
    expect(w.hosting.text('docs/a.txt')).toBe('a\n')
    expect(w.hosting.text('docs/cache.tmp')).toBe('made by the site')
  })

  it('orders the writes: freeing deletions, emptied folders deepest first, writes, the rest', () => {
    const layout = layoutOf(
      manifestOf({
        files: filesOf(
          { a: 'file a\n', 'b/x/1': '1', 'b/2': '2', 'c.txt': 'c' },
          {
            a: null,
            'a/new': 'n',
            b: 'file b',
            'b/x/1': null,
            'b/2': null,
            'c.txt': null,
            'd.txt': 'd',
          },
        ),
      }),
    )
    expect(layout.freeing.map((entry) => entry.path)).toEqual(['a', 'b/x/1', 'b/2'])
    expect(layout.emptied).toEqual(['b/x', 'b'])
    expect(layout.writes.map((entry) => entry.path)).toEqual(['a/new', 'b', 'd.txt'])
    expect(layout.later.map((entry) => entry.path)).toEqual(['c.txt'])
  })
})

describe('the rollback of an attempt (Р31)', () => {
  it('checks the site twice after the write, after pauses: a break the cache of the hosting hid at first is rolled back', async () => {
    // Stand R12: a PHP opcache served the old footer for a moment after the write, the first
    // check passed and the site broke two seconds later — the release was taken as installed.
    const w = world()
    const started = w.clock.now
    w.checks = [ok, ok, broken]
    expect(await deploy(contextOf(w))).toBe('rolled_back')
    expect(w.api.sequence).toContain('verify failed site_broken')
    expect(w.api.sequence.slice(-2)).toEqual(['reverify started', 'reverify succeeded'])
    // Baseline, two checks of verify, two of reverify; four pauses of the settle at least.
    expect(w.checked).toBe(5)
    expect(w.clock.now - started).toBeGreaterThanOrEqual(4 * deployLimits.verifySettleMs)
  })

  it('puts back the files in reverse, removes the folders it made, then the records, and checks the site again', async () => {
    const w = world()
    w.checks = [ok, broken]
    const timeline: string[] = []
    w.hosting.beforeChange = (kind, path) => void timeline.push(`${kind} ${path}`)
    w.gateway.beforeWrite = (request) => void timeline.push(`record ${request.objectRef}`)
    w.api.answer = (report) => {
      if (report.step === 'rollback' && report.state === 'started') timeline.push('ROLLBACK')
      return { accepted: true, proceed: true }
    }
    expect(await deploy(contextOf(w))).toBe('rolled_back')
    expect(w.api.sequence).toEqual([
      'conflicts started',
      'conflicts succeeded',
      'backup started',
      'backup succeeded',
      'files started',
      'files succeeded',
      'db started',
      'db succeeded',
      'verify started',
      'verify failed site_broken',
      'rollback started',
      'rollback succeeded',
      'reverify started',
      'reverify succeeded',
    ])
    expect(deployed(w)).toEqual(asInstalled)
    expect(w.gateway.records.get('page:42')).toEqual(priorPage)
    expect([...w.hosting.folders].sort()).toEqual(installedFolders)
    // The files first — broken code would keep the plugin from answering — in reverse, then
    // the folders it made, deepest first, then the record under «production holds what we wrote».
    expect(timeline.slice(timeline.indexOf('ROLLBACK') + 1)).toEqual([
      'write wp-content/themes/shop/old.css',
      'remove wp-content/uploads/raditi/banner.webp',
      'remove wp-content/themes/shop/new.css',
      'write index.php',
      'remove bin/cron.sh',
      'rmdir wp-content/uploads/raditi',
      'rmdir wp-content/uploads',
      'rmdir bin',
      'record page:42',
    ])
    expect(w.gateway.log).toEqual(['release page:42', 'restore page:42'])
    // Before the write; once after it (it failed); twice after the rollback.
    expect(w.checked).toBe(4)
    // The rollback ran on a connection of its own.
    expect(w.hosting.opened).toBe(2)
  })

  it('rolls back on a fresh connection when the one that wrote dropped', async () => {
    const w = world()
    let writes = 0
    w.hosting.beforeChange = (kind) => {
      if (kind === 'write' && (writes += 1) === 2) {
        // The connection drops in the middle of an upload: the session answers nothing more,
        // and the temporary of that upload stays on the hosting.
        w.hosting.dropConnections()
        throw new SiteConnectionError('transfer_failed')
      }
    }
    expect(await deploy(contextOf(w))).toBe('rolled_back')
    expect(w.api.sequence.slice(4)).toEqual([
      'files started',
      'files failed hosting_unavailable',
      'rollback started',
      'rollback succeeded',
      'reverify started',
      'reverify succeeded',
    ])
    w.hosting.beforeChange = null
    expect(deployed(w)).toEqual(asInstalled)
    expect(w.hosting.temporaries).toEqual([])
    expect([...w.hosting.folders].sort()).toEqual(installedFolders)
    expect(w.hosting.opened).toBe(2)
    // The record was never written: nothing to put back.
    expect(w.gateway.log).toEqual([])
  })

  it('opens the connection again when it drops during the rollback', async () => {
    const w = world()
    w.checks = [ok, broken]
    let rollingBack = false
    let dropped = false
    w.api.answer = (report) => {
      if (report.step === 'rollback') rollingBack = true
      return { accepted: true, proceed: true }
    }
    w.hosting.beforeChange = (kind) => {
      if (rollingBack && kind === 'remove' && !dropped) {
        dropped = true
        w.hosting.dropConnections()
        throw new SiteConnectionError('transfer_failed')
      }
    }
    expect(await deploy(contextOf(w))).toBe('rolled_back')
    expect(deployed(w)).toEqual(asInstalled)
    expect(w.hosting.opened).toBe(3)
  })

  it('ends unknown when the hosting does not answer the rollback, after bounded tries', async () => {
    const w = world()
    w.checks = [ok, broken]
    w.refuseSessionsFrom = 1
    const started = w.clock.now
    expect(await deploy(contextOf(w))).toBe('unknown')
    expect(w.api.sequence.slice(-2)).toEqual([
      'rollback started',
      'rollback unknown hosting_unavailable',
    ])
    // One forward session, then the first try of the rollback and one per pause.
    expect(w.sessions).toHaveLength(2 + deployLimits.reconnectPausesMs.length)
    const paused = deployLimits.reconnectPausesMs.reduce((sum, ms) => sum + ms, 0)
    expect(w.clock.now - started).toBeLessThan(paused + 60_000)
  })

  it('stops writing at its deadline and rolls back what it wrote', async () => {
    const w = world()
    w.hosting.beforeChange = (kind, path) => {
      if (kind === 'write' && path === 'bin/cron.sh') w.clock.now += deployLimits.forwardMs
    }
    expect(await deploy(contextOf(w))).toBe('rolled_back')
    expect(w.api.sequence).toContain('files failed stopped')
    w.hosting.beforeChange = null
    expect(deployed(w)).toEqual(asInstalled)
    // The forward session is never cut by a deadline: only a cancel of the job ends it.
    expect(w.sessions[0]).toBe(w.abort.signal)
  })

  it('leaves alone what someone else changed meanwhile and ends unknown', async () => {
    const w = world()
    w.checks = [ok, broken]
    const context = contextOf(w)
    const check = context.checkSite
    context.checkSite = async (verify) => {
      // Between the write and the rollback, the owner edits a file the release wrote.
      if (w.checked === 1) w.hosting.put('index.php', '<?php echo "правка владельца";\n')
      return check(verify)
    }
    expect(await deploy(context)).toBe('unknown')
    expect(w.api.sequence.slice(-2)).toEqual([
      'rollback started',
      'rollback unknown changed_meanwhile',
    ])
    expect(w.hosting.text('index.php')).toBe('<?php echo "правка владельца";\n')
    // Everything else is back.
    expect(w.hosting.text('wp-content/themes/shop/new.css')).toBeNull()
    expect(w.hosting.text('wp-content/themes/shop/old.css')).toBe(
      installed['wp-content/themes/shop/old.css'],
    )
    expect(w.gateway.records.get('page:42')).toEqual(priorPage)
  })

  it('ends unknown when the site does not come back after the rollback', async () => {
    const w = world()
    w.checks = [ok, broken, broken]
    expect(await deploy(contextOf(w))).toBe('unknown')
    expect(w.api.sequence.slice(-2)).toEqual(['reverify started', 'reverify failed site_broken'])
    expect(deployed(w)).toEqual(asInstalled)
  })

  it('replays a write whose answer was lost under the same identity: one write, one receipt', async () => {
    const w = world()
    w.gateway.loseAnswers = 1
    expect(await deploy(contextOf(w))).toBe('installed')
    expect(w.gateway.log).toEqual(['release page:42'])
    expect(w.gateway.receipts.size).toBe(1)
  })

  it('reconciles a write that never answered after its deadline, then rolls back', async () => {
    const w = world()
    w.gateway.failWrites = 10
    expect(await deploy(contextOf(w))).toBe('rolled_back')
    expect(w.api.sequence.slice(6)).toEqual([
      'db started',
      'db failed write_failed',
      'rollback started',
      'rollback succeeded',
      'reverify started',
      'reverify succeeded',
    ])
    expect(deployed(w)).toEqual(asInstalled)
  })

  it('rolls back what it wrote when core stops it after a write, without telling it more', async () => {
    const w = world()
    w.api.answer = (report) => ({
      accepted: true,
      proceed: !(report.step === 'files' && report.state === 'succeeded'),
    })
    expect(await deploy(contextOf(w))).toBe('rolled_back')
    expect(w.api.calls).not.toContain('report files:failed')
    expect(deployed(w)).toEqual(asInstalled)
  })

  it('rolls back after a cancel of the job', async () => {
    const w = world()
    w.hosting.beforeChange = (kind, path) => {
      if (
        kind === 'write' &&
        path === 'index.php' &&
        w.hosting.text('index.php') === installed['index.php']
      )
        w.abort.abort()
    }
    expect(await deploy(contextOf(w))).toBe('rolled_back')
    expect(w.api.sequence).toContain('files failed stopped')
    w.hosting.beforeChange = null
    expect(deployed(w)).toEqual(asInstalled)
  })
})

describe('the reports of a long deploy', () => {
  /** A plugin of `files` files in `folders` folders, added to a hosting that answers slowly. */
  function largeRelease(files: number, folders: number) {
    const to: Record<string, string> = {}
    for (let index = 0; index < files; index += 1)
      to[`wp-content/plugins/big/f${index % folders}/file${index}.php`] = `<?php // ${index}\n`
    const manifest = manifestOf({ files: filesOf(installed, to), db: [] })
    const w = world(manifest)
    w.tree = to
    // 35 ms a request, as to a hosting far away.
    w.hosting.onRequest = () => {
      w.clock.now += 35
    }
    return w
  }

  it('repeats the start of a long step every minute, so core never hears 30 min of silence', async () => {
    const w = largeRelease(3000, 30)
    const started = w.clock.now
    expect(await deploy(contextOf(w))).toBe('installed')
    const elapsed = w.clock.now - started
    expect(elapsed).toBeGreaterThan(5 * 60_000)
    const times = [started, ...w.api.delivered.map((report) => report.at)]
    const gaps = times.slice(1).map((at, index) => at - times[index]!)
    expect(Math.max(...gaps)).toBeLessThan(deployLimits.heartbeatMs + 5_000)
    const beats = w.api.delivered.filter((report) => report.key === 'files:started')
    expect(beats.length).toBeGreaterThan(3)
    // A repeat is the same report: core keeps one row per key.
    expect(w.api.sequence.filter((line) => line === 'files started')).toHaveLength(1)
  })

  it('stops and rolls back when core refuses a heartbeat', async () => {
    const w = largeRelease(400, 4)
    let beats = 0
    w.api.answer = (report) => ({
      accepted: true,
      proceed: !(report.step === 'files' && report.state === 'started' && (beats += 1) > 1),
    })
    expect(await deploy(contextOf(w))).toBe('rolled_back')
    expect(w.api.calls).not.toContain('report files:failed')
    expect(w.hosting.text('wp-content/plugins/big/f0/file0.php')).toBeNull()
    expect(w.hosting.folders.has('wp-content/plugins')).toBe(false)
  })

  it('offers the end of the deploy to core until it answers', async () => {
    const w = world()
    let tries = 0
    w.api.drop = (report) => report.step === 'verify' && report.state === 'succeeded' && ++tries < 3
    const started = w.clock.now
    expect(await deploy(contextOf(w))).toBe('installed')
    expect(w.api.sequence.at(-1)).toBe('verify succeeded')
    expect(w.clock.now - started).toBeGreaterThanOrEqual(2 * deployLimits.endReportPauseMs)
  })

  it('says so when core never takes the end, or refuses it', async () => {
    const silent = world()
    silent.api.drop = (report) => report.step === 'verify' && report.state === 'succeeded'
    const started = silent.clock.now
    expect(await runDeploy(contextOf(silent))).toEqual({ outcome: 'installed', told: false })
    expect(silent.clock.now - started).toBeGreaterThanOrEqual(deployLimits.endReportMs)

    const refused = world()
    refused.api.answer = (report) => {
      if (report.step === 'verify' && report.state === 'succeeded') throw new ReleaseApiError(409)
      return { accepted: true, proceed: true }
    }
    const at = refused.clock.now
    expect(await runDeploy(contextOf(refused))).toEqual({ outcome: 'installed', told: false })
    // Only the two pauses of the check: a refused end is not offered again.
    expect(refused.clock.now - at).toBe(2 * deployLimits.verifySettleMs)
  })
})

describe('the code cache of the site (stand R12)', () => {
  const cacheOf = (state: Partial<ConstructorParameters<typeof FakeCodeCache>[0]> = {}) =>
    new FakeCodeCache({
      version: 1,
      kind: 'code_cache',
      enabled: true,
      validateTimestamps: true,
      revalidateSeconds: 2,
      refresh: true,
      ...state,
    })
  /** The time from the end of the writes to the last check, by the clock of the test. */
  const checkedAfter = (w: World, context: DeployContext) => {
    const site = context.checkSite
    const at: number[] = []
    context.checkSite = async (verify) => {
      at.push(w.clock.now)
      return site(verify)
    }
    return at
  }

  it('drops the code it wrote from the cache, then checks after the usual pause', async () => {
    const w = world()
    const cache = cacheOf({ revalidateSeconds: 60 })
    const context = { ...contextOf(w), codeCache: () => cache }
    const at = checkedAfter(w, context)
    expect(await deploy(context)).toBe('installed')
    // Only PHP: the styles, the picture and the script are no code of the cache.
    expect(cache.refreshes).toEqual([['index.php']])
    expect(at[2]! - at[1]!).toBe(deployLimits.verifySettleMs)
    expect(w.logs).toContain('deploy-step: code cache refreshed for 1 of 1 files')
  })

  it('waits the time the cache looks at file times, plus a margin, when the plugin cannot drop', async () => {
    const w = world()
    const context = {
      ...contextOf(w),
      codeCache: () => cacheOf({ revalidateSeconds: 30, refresh: false }),
    }
    const at = checkedAfter(w, context)
    expect(await deploy(context)).toBe('installed')
    expect(at[2]! - at[1]!).toBe(30_000 + deployLimits.codeCacheMarginMs)
  })

  it('writes nothing when the cache never looks at file times and the plugin cannot drop', async () => {
    for (const state of [
      { validateTimestamps: false, refresh: false },
      { revalidateSeconds: 600, refresh: false },
    ]) {
      const w = world()
      const context = { ...contextOf(w), codeCache: () => cacheOf(state) }
      expect(await deploy(context)).toBe('failed')
      expect(w.api.sequence).toEqual(['conflicts started', 'conflicts failed code_cache'])
      expect(deployed(w)).toEqual(asInstalled)
      expect(w.api.backup).toBeNull()
    }
  })

  it('rolls back when the cache could not be told and its times prove nothing', async () => {
    const w = world()
    const cache = cacheOf({ validateTimestamps: false })
    cache.failRefreshes = 1
    const context = { ...contextOf(w), codeCache: () => cache }
    expect(await deploy(context)).toBe('rolled_back')
    expect(w.api.sequence).toEqual([
      'conflicts started',
      'conflicts succeeded',
      'backup started',
      'backup succeeded',
      'files started',
      'files failed code_cache',
      'rollback started',
      'rollback succeeded',
      'reverify started',
      'reverify succeeded',
    ])
    // The rollback told the cache of the code it put back.
    expect(cache.refreshes).toEqual([['index.php']])
    expect(deployed(w)).toEqual(asInstalled)
  })

  it('ends unknown when the rollback cannot tell the cache either', async () => {
    const w = world()
    const cache = cacheOf({ validateTimestamps: false })
    cache.failRefreshes = 2
    const context = { ...contextOf(w), codeCache: () => cache }
    expect(await deploy(context)).toBe('unknown')
    expect(w.api.sequence.slice(-3)).toEqual([
      'rollback succeeded',
      'reverify started',
      'reverify failed code_cache',
    ])
    expect(deployed(w)).toEqual(asInstalled)
  })

  it('keeps the usual pause when the plugin does not say, or there is no cache', async () => {
    for (const cache of [
      Object.assign(cacheOf({ refresh: false, revalidateSeconds: 60 }), { unknown: true }),
      cacheOf({ enabled: false, validateTimestamps: false, refresh: false }),
    ]) {
      const w = world()
      const context = { ...contextOf(w), codeCache: () => cache }
      const at = checkedAfter(w, context)
      expect(await deploy(context)).toBe('installed')
      expect(at[2]! - at[1]!).toBe(deployLimits.verifySettleMs)
      expect(cache.refreshes).toEqual([])
    }
  })
})

describe('an attempt «только возврат» (Р31)', () => {
  async function leftByAttemptOne(): Promise<World> {
    // Attempt 1 wrote everything and ended unknown; attempt 2 has only its backup.
    const first = world()
    await deploy(contextOf(first))
    const sealed = (
      await sealBackup(
        {
          releaseId,
          deployAttempt: 1,
          files: [
            { path: 'index.php', bytes: Buffer.from(installed['index.php']), mode: 0o644 },
            {
              path: 'wp-content/themes/shop/old.css',
              bytes: Buffer.from(installed['wp-content/themes/shop/old.css']),
              mode: 0o640,
            },
          ],
          records: [priorPage],
          folders: ['bin', 'wp-content/uploads', 'wp-content/uploads/raditi'],
        },
        key,
      )
    ).sealed
    const backupUrl = 'https://s3.example.test/raditi-backups/1/backup.tar.zst.enc'
    const second = world(
      manifestOf({
        deployAttempt: 2,
        rollbackOf: {
          deployAttempt: 1,
          backup: { ...presigned, url: backupUrl },
          sha256: sha256Hex(sealed),
          sizeBytes: sealed.byteLength,
        },
      }),
    )
    second.hosting = first.hosting
    second.gateway = first.gateway
    second.value = Buffer.from(sealed)
    return second
  }

  it('restores from the backup of the earlier attempt and writes nothing new', async () => {
    const w = await leftByAttemptOne()
    const context = contextOf(w)
    context.wrap = { ...wrap, attempt: 2 }
    context.download = async () => w.value
    expect(await deploy(context)).toBe('rolled_back')
    expect(w.api.sequence).toEqual([
      'rollback started',
      'rollback succeeded',
      'reverify started',
      'reverify succeeded',
    ])
    expect(deployed(w)).toEqual(asInstalled)
    expect([...w.hosting.folders].sort()).toEqual(installedFolders)
    expect(w.hosting.files.get('wp-content/themes/shop/old.css')!.mode).toBe(0o640)
    expect(w.api.accessCalls).toBe(1)
    expect(w.treeReads).toEqual([])
  })

  it('ends unknown with a backup that is not the one core verified', async () => {
    const w = await leftByAttemptOne()
    const context = contextOf(w)
    context.wrap = { ...wrap, attempt: 2 }
    context.download = async () => Buffer.concat([w.value, Buffer.from('x')])
    expect(await deploy(context)).toBe('unknown')
    expect(w.api.sequence).toEqual(['rollback started', 'rollback unknown source_mismatch'])
    expect(w.hosting.text('index.php')).toBe(approved['index.php'])
  })
})
