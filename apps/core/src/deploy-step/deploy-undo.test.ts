import {
  undoOperationOf,
  type DbOperation,
  type DbUndoOperation,
  type DeployAccess,
  type DeployManifest,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import {
  sealDbOperationValue,
  sealDeployValue,
  undoOperationPayload,
} from '../releases/release-db-values.ts'
import {
  contentState,
  createdState,
  FakeReleaseApi,
  MemoryContentGateway,
  MemoryDbGateway,
  MemoryHosting,
} from '../testing/deploy-step.ts'
import { openBackup } from './backup.ts'
import { absentHashOf, contentCallId, createdHashOf, optionHashOf } from './content.ts'
import { runDeploy, type DeployContext } from './deploy.ts'
import type { SiteCheckResult } from './site-check.ts'

// «Отменить выпуск» on production (docs/plan/53, «Отмена выпуска»): the job of an undo writes what
// production held before the release in the plugin's mode `restore` — a text, a setting, and a
// new page of the release to the trash —, only where production holds what the release wrote and
// nothing of the site stands on the page; it goes on when the site fails its check before the
// write, and a rollback brings the page back from the trash.

const releasedId = '0196abcd-0000-7000-8000-00000000000a'
const undoId = '0196abcd-0000-7000-8000-00000000000b'
const siteId = '0196abcd-0000-7000-8000-0000000000aa'
const approvedSha = '3f786850e387550fdab836ed7e6dc881de23001b'
const key = Buffer.alloc(32, 7)
const ok: SiteCheckResult = { ok: true, pages: 1, failed: 0 }
const broken: SiteCheckResult = { ok: false, pages: 1, failed: 1 }
const ref = (n: number) => ({ key: `tasks/t/db/${n}.json`, sha256: 'a'.repeat(64), sizeBytes: 10 })
const page = {
  status: 'publish' as const,
  slug: 'prices',
  title: 'Цены',
  content: '<p>От 500 ₽</p>',
  excerpt: '',
}
const priorTitle = contentState('page:42', { title: 'Контакты', content: '<p>Пишите</p>' })
const releasedTitle = contentState('page:42', {
  title: 'Контакты и реквизиты',
  content: '<p>Пишите</p>',
})
const before = 'Цветы у дома'
const released = 'Цветы у дома — доставка за час'
const createCallId = contentCallId(releasedId, 1, 'page:1000000001', 'apply')

/** The operations of the release undone, as its plan kept them. */
const release: Record<string, DbOperation> = {
  option: {
    kind: 'option_update',
    objectRef: 'option:blogdescription',
    fields: ['value'],
    beforeHash: optionHashOf('option:blogdescription', before),
    afterHash: optionHashOf('option:blogdescription', released),
    before: ref(3),
    after: ref(4),
  },
  page: {
    kind: 'post_create',
    objectRef: 'page:1000000001',
    fields: ['title', 'content', 'excerpt'],
    beforeHash: absentHashOf('page:1000000001'),
    afterHash: createdState('page:1000000001', page).stateHash,
    before: ref(5),
    after: ref(6),
  },
  title: {
    kind: 'content_update',
    objectRef: 'page:42',
    fields: ['title'],
    beforeHash: priorTitle.stateHash,
    afterHash: releasedTitle.stateHash,
    before: ref(7),
    after: ref(8),
  },
}

/** The writes of the undo, in the reverse of the release's order, and what each puts back. */
const undoPlan: { operation: DbUndoOperation; payload: unknown }[] = [
  {
    operation: undoOperationOf(release.title!)!,
    payload: undoOperationPayload(undoOperationOf(release.title!)!, priorTitle),
  },
  {
    operation: undoOperationOf(release.page!, {
      productionRef: 'page:900',
      stateHash: createdHashOf('page:900', page),
      absentHash: absentHashOf('page:900'),
    })!,
    payload: { v: 1, slug: 'prices', createCallId },
  },
  {
    operation: undoOperationOf(release.option!)!,
    payload: { v: 1, value: before },
  },
]
const urlOf = (index: number) => `https://core.example.test/v1/releases/x/values/${index}`

function manifestOf(overrides: Partial<DeployManifest> = {}): DeployManifest {
  return {
    v: 1,
    kind: 'undo',
    releaseId: undoId,
    siteId,
    deployAttempt: 1,
    tag: 'v1.5.1',
    installedSha: 'c'.repeat(40),
    approvedSha,
    method: 'sftp',
    files: { write: [], delete: [] },
    db: undoPlan.map(({ operation }, index) => ({
      operation,
      after: {
        method: 'GET',
        url: urlOf(index),
        headers: {},
        expiresAt: '2026-10-18T21:00:00.000Z',
      },
    })),
    contentEpoch: 7,
    rollbackOf: null,
    addOnlyPaths: [],
    verify: { origin: 'https://shop.example.ru', failureMarkers: [], pages: ['/'] },
    ...overrides,
  }
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
  content: MemoryContentGateway
  db: MemoryDbGateway
  api: FakeReleaseApi
  values: Map<string, Buffer>
  checks: SiteCheckResult[]
  checked: number
  clock: { now: number }
}

/** Production as the release left it: its title, its setting, its page `page:900`. */
function world(manifest = manifestOf()): World {
  const content = new MemoryContentGateway(siteId, [releasedTitle])
  const db = new MemoryDbGateway(content)
  content.db = db
  db.options.set('option:blogdescription', released)
  db.created.set('page:900', { record: page, mark: createCallId, trashed: false })
  const values = new Map<string, Buffer>()
  undoPlan.forEach(({ operation, payload }, index) =>
    values.set(urlOf(index), sealDeployValue(payload as never, operation, undoId, 'undo', key)),
  )
  const clock = { now: 1_800_000_000_000 }
  const api = new FakeReleaseApi(manifest, access)
  api.now = () => clock.now
  return { content, db, api, values, checks: [], checked: 0, clock }
}

function contextOf(w: World): DeployContext {
  return {
    wrap: { releaseId: undoId, attempt: 1, tag: 'v1.5.1', sha: approvedSha, wrapToken: 'hvs.x1' },
    api: w.api,
    backupKey: key,
    tree: {
      async file() {
        throw new Error('No files in this undo')
      },
    },
    openHosting: async () => new MemoryHosting({}).session(),
    contentGateway: () => w.content,
    download: async (request) => {
      const value = w.values.get(request.url)
      if (!value) throw new Error('Unknown object')
      return value
    },
    upload: async (_request, body) => {
      w.api.backup = Buffer.from(body)
    },
    checkSite: async () => {
      const result = w.checks[w.checked] ?? ok
      w.checked += 1
      return result
    },
    log: () => {},
    signal: new AbortController().signal,
    now: () => w.clock.now,
    sleep: async (ms) => {
      w.clock.now += ms
    },
  }
}

async function deploy(w: World) {
  const result = await runDeploy(contextOf(w))
  expect(result.told).toBe(true)
  return result.outcome
}

const nothingWritten = (w: World) => expect([...w.db.log, ...w.content.log]).toEqual([])

describe('an undo of a release on production', () => {
  it('puts back what the site held before the release, in the mode restore', async () => {
    const w = world()
    expect(await deploy(w)).toBe('installed')
    expect(w.content.log).toEqual(['restore page:42'])
    expect(w.db.log).toEqual([
      'restore post_trash page:900',
      'restore option_update option:blogdescription',
    ])
    expect(w.content.records.get('page:42')).toEqual(priorTitle)
    expect(w.db.options.get('option:blogdescription')).toBe(before)
    expect(w.db.created.get('page:900')?.trashed).toBe(true)
    // The backup keeps what the release left: the rollback of the undo puts it back.
    const backup = await openBackup(w.api.backup!, key, undoId, 1)
    expect(backup.records.map((record) => record.objectRef).sort()).toEqual([
      'option:blogdescription',
      'page:42',
      'page:900',
    ])
  })

  it('writes nothing where the site changed since the release, or stands on the new page', async () => {
    const changes: ((w: World) => void)[] = [
      (w) => w.db.editCreated('page:900', 'Наши цены'),
      // Only the address: the hash of a record leaves it out, the page changed all the same.
      (w) => {
        const item = w.db.created.get('page:900')!
        item.record = { ...item.record, slug: 'nashi-ceny' }
      },
      (w) => w.db.dependentsOf.set('page:900', 2),
      (w) => w.db.options.set('option:blogdescription', 'Другое описание'),
      (w) =>
        w.content.records.set(
          'page:42',
          contentState('page:42', { title: 'Правка владельца', content: '<p>Пишите</p>' }),
        ),
    ]
    for (const change of changes) {
      const w = world()
      change(w)
      expect(await deploy(w)).toBe('failed')
      expect(w.api.sequence.at(-1)).toBe('conflicts failed conflict')
      nothingWritten(w)
    }
  })

  it('believes no state whose hash is not of its own fields', async () => {
    const w = world()
    const read = w.content.read.bind(w.content)
    w.content.read = async (objectRef) => ({ ...(await read(objectRef)), title: 'Подмена CDN' })
    expect(await deploy(w)).toBe('failed')
    expect(w.api.sequence.at(-1)).toBe('conflicts failed content_unavailable')
    nothingWritten(w)
  })

  it('does not open a value sealed for a release', async () => {
    const w = world()
    const [first] = undoPlan
    w.values.set(
      urlOf(0),
      sealDbOperationValue(
        { after: priorTitle, before: null },
        first!.operation as DbOperation,
        undoId,
        key,
      ),
    )
    expect(await deploy(w)).toBe('failed')
    expect(w.api.sequence.at(-1)).toBe('conflicts failed source_mismatch')
    nothingWritten(w)
  })

  it('brings the page back from the trash when the site fails its check after the undo', async () => {
    const w = world()
    w.checks = [ok, broken]
    expect(await deploy(w)).toBe('rolled_back')
    expect(w.db.log).toEqual([
      'restore post_trash page:900',
      'restore option_update option:blogdescription',
      'restore option_update option:blogdescription',
      'restore post_untrash page:900',
    ])
    expect(w.content.records.get('page:42')).toEqual(releasedTitle)
    expect(w.db.options.get('option:blogdescription')).toBe(released)
    expect(w.db.created.get('page:900')).toMatchObject({ trashed: false, record: page })
  })

  it('goes on when the site fails its check before the write, and installs if it mends it', async () => {
    const w = world()
    w.checks = [broken]
    expect(await deploy(w)).toBe('installed')
    expect(
      w.api.reports.find((report) => report.step === 'conflicts' && report.state === 'succeeded')
        ?.detail,
    ).toMatchObject({ brokenBefore: true })
    expect(w.db.created.get('page:900')?.trashed).toBe(true)
  })

  it('leaves the site to the operator when it fails the check before the undo and after it', async () => {
    const w = world()
    w.checks = [broken, broken]
    expect(await deploy(w)).toBe('unknown')
    expect(w.api.sequence.at(-1)).toBe('verify unknown site_broken_both')
    // Nothing is put back: the version undone failed the same check.
    expect(w.db.log).toEqual([
      'restore post_trash page:900',
      'restore option_update option:blogdescription',
    ])
  })

  it('hands a site broken before the undo to the operator at once when a write fails', async () => {
    const w = world()
    w.checks = [broken, broken]
    // No write of the undo lands: the rollback finds nothing to put back.
    w.content.failWrites = 100
    expect(await deploy(w)).toBe('unknown')
    // Not `site_broken`: an attempt «только возврат» would mend nothing either (Ж7).
    expect(w.api.sequence.at(-1)).toBe('reverify failed site_broken_both')
    expect(w.checked).toBe(2)
  })

  it('does not take a release past a broken site: only an undo goes on', async () => {
    const w = world(manifestOf({ kind: 'release', db: [] }))
    w.checks = [broken]
    expect(await deploy(w)).toBe('failed')
    expect(w.api.sequence).toEqual(['conflicts started', 'conflicts failed site_broken_before'])
  })
})
