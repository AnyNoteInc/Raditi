import type {
  DbObjectState,
  DbOperation,
  DbOptionState,
  DbTableState,
  DeployAccess,
  DeployManifest,
  PublishedContentState,
  TableDefinition,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { sealDbOperationValue, type DbOperationStates } from '../releases/release-db-values.ts'
import {
  contentState,
  createdState,
  FakeReleaseApi,
  MemoryContentGateway,
  MemoryDbGateway,
  MemoryHosting,
  sha256Hex,
} from '../testing/deploy-step.ts'
import { openBackup, sealBackup } from './backup.ts'
import {
  absentHashOf,
  contentCallId,
  createdHashOf,
  migratedHashOf,
  optionHashOf,
  tableHashOf,
} from './content.ts'
import { runDeploy, verifyAfterWrites, type DeployContext } from './deploy.ts'
import type { SiteCheckResult } from './site-check.ts'

// The database plan of a release beyond text changes (docs/plan/53, «Операции БД и миграции»):
// a table of the platform, a setting, a new page and a text change, written in the plan's order
// and returned in the reverse one — the setting back, the page to the trash only while it holds
// what the release wrote, the table kept.

const releaseId = '0196abcd-0000-7000-8000-00000000000a'
const siteId = '0196abcd-0000-7000-8000-0000000000aa'
const approvedSha = '3f786850e387550fdab836ed7e6dc881de23001b'
const key = Buffer.alloc(32, 9)
const ok: SiteCheckResult = { ok: true, pages: 1, failed: 0 }
const broken: SiteCheckResult = { ok: false, pages: 1, failed: 1 }
const ref = (n: number) => ({ key: `tasks/t/db/${n}.json`, sha256: 'a'.repeat(64), sizeBytes: 10 })

const definition: TableDefinition = {
  columns: [
    { name: 'name', type: 'string', length: 120, nullable: false, default: { value: '' } },
    { name: 'starts_at', type: 'datetime', nullable: true },
  ],
  indexes: [{ name: 'by_start', columns: ['starts_at'], unique: false }],
}
const noTable = { exists: false, managed: false, definition: null }
const page = {
  status: 'publish' as const,
  slug: 'prices',
  title: 'Цены',
  content: '<p>От 500 ₽</p>',
  excerpt: '',
}
const priorTitle = contentState('page:42', { title: 'Контакты', content: '<p>Пишите</p>' })
const nextTitle = contentState('page:42', {
  title: 'Контакты и реквизиты',
  content: '<p>Пишите</p>',
})

const states = (after: DbObjectState, before: DbObjectState | null = null): DbOperationStates => ({
  after,
  before,
})
const tableState = (
  table: Pick<DbTableState, 'exists' | 'managed' | 'definition'>,
): DbTableState => ({
  version: 1,
  objectRef: 'table:bookings',
  ...table,
  stateHash: tableHashOf('table:bookings', table),
})
const optionState = (value: string | null): DbOptionState => ({
  version: 1,
  objectRef: 'option:blogdescription',
  value,
  stateHash: optionHashOf('option:blogdescription', value),
})
const createdPreview = createdState('page:1000000001', page)

/** The four operations of the plan, in its one order, and the states their values seal. */
const plan: { operation: DbOperation; states: DbOperationStates }[] = [
  {
    operation: {
      kind: 'schema_migration',
      objectRef: 'table:bookings',
      fields: ['definition'],
      beforeHash: tableHashOf('table:bookings', noTable),
      afterHash: migratedHashOf('table:bookings', definition),
      before: ref(1),
      after: ref(2),
    },
    states: states(tableState({ exists: true, managed: true, definition }), tableState(noTable)),
  },
  {
    operation: {
      kind: 'option_update',
      objectRef: 'option:blogdescription',
      fields: ['value'],
      beforeHash: optionHashOf('option:blogdescription', 'Цветы у дома'),
      afterHash: optionHashOf('option:blogdescription', 'Цветы у дома — доставка за час'),
      before: ref(3),
      after: ref(4),
    },
    states: states(optionState('Цветы у дома — доставка за час')),
  },
  {
    operation: {
      kind: 'post_create',
      objectRef: 'page:1000000001',
      fields: ['title', 'content', 'excerpt'],
      beforeHash: absentHashOf('page:1000000001'),
      afterHash: createdPreview.stateHash,
      before: ref(5),
      after: ref(6),
    },
    states: states(createdPreview),
  },
  {
    operation: {
      kind: 'content_update',
      objectRef: 'page:42',
      fields: ['title'],
      beforeHash: priorTitle.stateHash,
      afterHash: nextTitle.stateHash,
      before: ref(7),
      after: ref(8),
    },
    states: states(nextTitle),
  },
]
const urlOf = (index: number) => `https://core.example.test/v1/releases/x/values/${index}`

function manifestOf(overrides: Partial<DeployManifest> = {}): DeployManifest {
  return {
    v: 1,
    kind: 'release',
    releaseId,
    siteId,
    deployAttempt: 1,
    tag: 'v1.5.0',
    installedSha: 'c'.repeat(40),
    approvedSha,
    method: 'sftp',
    files: { write: [], delete: [] },
    db: plan.map(({ operation }, index) => ({
      operation,
      after: {
        method: 'GET',
        url: urlOf(index),
        headers: {},
        expiresAt: '2026-10-18T21:00:00.000Z',
      },
    })),
    contentEpoch: 5,
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
  hosting: MemoryHosting
  content: MemoryContentGateway
  db: MemoryDbGateway
  api: FakeReleaseApi
  values: Map<string, Buffer>
  checks: SiteCheckResult[]
  checked: number
  /** Called after each check of the site: production may change between the write and the end. */
  afterCheck: ((count: number) => void) | null
  /** The pages each check of the site asked for, in order. */
  verified: string[][]
  clock: { now: number }
}

function world(manifest = manifestOf()): World {
  const content = new MemoryContentGateway(siteId, [priorTitle])
  const db = new MemoryDbGateway(content)
  content.db = db
  db.options.set('option:blogdescription', 'Цветы у дома')
  const values = new Map<string, Buffer>()
  plan.forEach(({ operation, states: sealed }, index) =>
    values.set(urlOf(index), sealDbOperationValue(sealed, operation, releaseId, key)),
  )
  const clock = { now: 1_800_000_000_000 }
  const api = new FakeReleaseApi(manifest, access)
  api.now = () => clock.now
  return {
    hosting: new MemoryHosting({}),
    content,
    db,
    api,
    values,
    checks: [],
    checked: 0,
    afterCheck: null,
    verified: [],
    clock,
  }
}

function contextOf(w: World, attempt = 1): DeployContext {
  return {
    wrap: { releaseId, attempt, tag: 'v1.5.0', sha: approvedSha, wrapToken: 'hvs.x1234567' },
    api: w.api,
    backupKey: key,
    tree: {
      async file() {
        throw new Error('No files in this plan')
      },
    },
    openHosting: async () => w.hosting.session(),
    contentGateway: () => w.content,
    download: async (request) => {
      const value = w.values.get(request.url)
      if (!value) throw new Error('Unknown object')
      return value
    },
    upload: async (_request, body) => {
      w.api.backup = Buffer.from(body)
    },
    checkSite: async (verify) => {
      w.verified.push([...verify.pages])
      const result = w.checks[w.checked] ?? ok
      w.checked += 1
      w.afterCheck?.(w.checked)
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

async function deploy(context: DeployContext) {
  const result = await runDeploy(context)
  expect(result.told).toBe(true)
  return result.outcome
}

const rollbackDetail = (w: World) =>
  w.api.reports.find((report) => report.step === 'rollback' && report.state !== 'started')?.detail

describe('a database plan of every kind on production', () => {
  it('writes the structure, the setting, the new page and the text in the order of the plan', async () => {
    const w = world()
    expect(await deploy(contextOf(w))).toBe('installed')
    expect(w.db.log).toEqual([
      'release schema_migration table:bookings',
      'release option_update option:blogdescription',
      'release post_create page:1000000001',
    ])
    expect(w.content.log).toEqual(['release page:42'])
    expect(w.db.tables.get('table:bookings')).toEqual({ exists: true, managed: true, definition })
    expect(w.db.options.get('option:blogdescription')).toBe('Цветы у дома — доставка за час')
    // Production gave the page its own id; its mark is the call that created it.
    const created = w.db.created.get('page:900')!
    expect(created.record).toEqual(page)
    expect(created.mark).toBe(contentCallId(releaseId, 1, 'page:1000000001', 'apply'))
    expect(w.db.receipts.get(created.mark)?.proof.createdRef).toBe('page:900')
    expect(w.content.records.get('page:42')).toEqual(nextTitle)
    // The prior setting is in the backup; a new record and a table have no prior state.
    const backup = await openBackup(w.api.backup!, key, releaseId, 1)
    expect(backup.records.map((record) => record.objectRef).sort()).toEqual([
      'option:blogdescription',
      'page:42',
    ])
  })

  it('goes on where a repeated release finds the table already extended', async () => {
    const w = world()
    w.db.tables.set('table:bookings', { exists: true, managed: true, definition })
    expect(await deploy(contextOf(w))).toBe('installed')
    expect(w.db.log[0]).toBe('release schema_migration table:bookings')
  })

  it('refuses before any write a plugin that cannot write a kind or a setting of the plan', async () => {
    for (const change of [
      (db: MemoryDbGateway) => {
        db.capabilitiesOf.operations = ['content_update', 'option_update']
      },
      (db: MemoryDbGateway) => {
        db.capabilitiesOf.settings = ['blogname']
      },
    ]) {
      const w = world()
      change(w.db)
      expect(await deploy(contextOf(w))).toBe('failed')
      expect(w.api.sequence).toEqual(['conflicts started', 'conflicts failed plugin_outdated'])
      expect([...w.db.log, ...w.content.log]).toEqual([])
    }
    // A plugin without the database part at all.
    const w = world()
    w.content.db = undefined
    expect(await deploy(contextOf(w))).toBe('failed')
    expect(w.api.sequence.at(-1)).toBe('conflicts failed plugin_outdated')
  })

  it('refuses before any write an address taken on production, and a base that moved', async () => {
    const taken = world()
    taken.db.taken.add('page/prices')
    expect(await deploy(contextOf(taken))).toBe('failed')
    expect(taken.api.sequence.at(-1)).toBe('conflicts failed conflict')
    expect(taken.db.log).toEqual([])

    const moved = world()
    moved.db.options.set('option:blogdescription', 'Правка владельца')
    expect(await deploy(contextOf(moved))).toBe('failed')
    expect(moved.api.sequence.at(-1)).toBe('conflicts failed conflict')

    const foreign = world()
    foreign.db.tables.set('table:bookings', { exists: true, managed: false, definition: null })
    expect(await deploy(contextOf(foreign))).toBe('failed')
    expect(foreign.api.sequence.at(-1)).toBe('conflicts failed conflict')
    expect(foreign.db.log).toEqual([])
  })

  it('refuses a value that does not lead to the state of the plan', async () => {
    const w = world()
    w.values.set(
      urlOf(2),
      sealDbOperationValue(
        states(createdState('page:1000000001', { ...page, title: 'Другое' })),
        plan[2]!.operation,
        releaseId,
        key,
      ),
    )
    expect(await deploy(contextOf(w))).toBe('failed')
    expect(w.api.sequence.at(-1)).toBe('conflicts failed source_mismatch')
  })

  it('returns every kind after a failed check: the setting back, the page in the trash, the table kept', async () => {
    const w = world()
    w.checks = [ok, broken]
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
    // In the reverse order: the text, the page, the setting; the table is not touched.
    expect(w.content.log).toEqual(['release page:42', 'restore page:42'])
    expect(w.db.log.slice(3)).toEqual([
      'restore post_trash page:900',
      'restore option_update option:blogdescription',
    ])
    expect(w.db.options.get('option:blogdescription')).toBe('Цветы у дома')
    expect(w.db.created.get('page:900')?.trashed).toBe(true)
    expect(w.db.tables.get('table:bookings')?.definition).toEqual(definition)
    expect(rollbackDetail(w)).toEqual({ files: 0, objects: 3, keptTables: 1 })
  })

  // docs/plan/53, «Операции БД и миграции», critique S9.
  describe('the page of a published record it created', () => {
    const withPages = () =>
      manifestOf({
        verify: {
          origin: 'https://shop.example.ru',
          failureMarkers: [],
          pages: ['/'],
          recordPages: { page: '/?page_id={id}', post: '/?p={id}' },
        },
      })

    it('is checked after the writes by the number production gave it, not before them', async () => {
      const w = world(withPages())
      expect(await deploy(contextOf(w))).toBe('installed')
      // Before the writes the page is not there; after them, twice, it must answer.
      expect(w.verified).toEqual([['/'], ['/', '/?page_id=900'], ['/', '/?page_id=900']])
    })

    it('fails the release when it does not answer: the page goes to the trash', async () => {
      const w = world(withPages())
      const context = contextOf(w)
      const check = context.checkSite
      context.checkSite = async (verify) => {
        const result = await check(verify)
        return verify.pages.includes('/?page_id=900') ? broken : result
      }
      expect(await deploy(context)).toBe('rolled_back')
      expect(w.api.sequence).toContain('verify failed site_broken')
      expect(w.db.created.get('page:900')?.trashed).toBe(true)
      // The check after the rollback asks for the pages of the manifest alone.
      expect(w.verified.at(-1)).toEqual(['/'])
    })

    it('is not asked for without the pages of records, nor for a draft', () => {
      const verify = withPages().verify
      const created = new Map([
        ['page:1000000001', { productionRef: 'page:900', record: { status: 'publish' } }],
        ['page:1000000002', { productionRef: 'page:901', record: { status: 'draft' } }],
        ['post:1000000003', { productionRef: 'post:77', record: { status: 'publish' } }],
      ])
      expect(verifyAfterWrites(verify, created).pages).toEqual(['/', '/?page_id=900', '/?p=77'])
      const { recordPages: _none, ...without } = verify
      expect(verifyAfterWrites(without, created).pages).toEqual(['/'])
    })
  })

  it('keeps a new page someone changed after the release; the end is still rolled back', async () => {
    const w = world()
    w.checks = [ok, broken]
    // Between the write and the rollback the owner edits the new page in the admin.
    w.afterCheck = (count) => {
      if (count === 2) w.db.editCreated('page:900', 'Цены (правка владельца)')
    }
    expect(await deploy(contextOf(w))).toBe('rolled_back')
    expect(w.db.created.get('page:900')).toMatchObject({ trashed: false })
    expect(rollbackDetail(w)).toEqual({ files: 0, objects: 2, keptRecords: 1, keptTables: 1 })
  })

  it('ends unknown when a setting was changed by someone else meanwhile', async () => {
    const w = world()
    w.checks = [ok, broken]
    w.afterCheck = (count) => {
      if (count === 2) w.db.options.set('option:blogdescription', 'Правка владельца')
    }
    expect(await deploy(contextOf(w))).toBe('unknown')
    expect(w.api.sequence.at(-1)).toBe('rollback unknown changed_meanwhile')
    expect(w.db.options.get('option:blogdescription')).toBe('Правка владельца')
  })

  it('finds a page whose receipt it lost, and trashes it', async () => {
    const w = world()
    w.checks = [ok, broken]
    // The creation lands, its answer and the retries' answers are lost: the reconcile finds it.
    w.db.beforeWrite = (request) => {
      if (request.change.kind === 'post_create') w.db.loseAnswers = 3
    }
    expect(await deploy(contextOf(w))).toBe('rolled_back')
    expect(w.db.created.get('page:900')?.trashed).toBe(true)
  })
})

describe('an attempt «только возврат» of a database plan', () => {
  /** Attempt 1 wrote everything and was lost; its backup is what core verified. */
  async function leftByAttemptOne() {
    // Attempt 1 wrote everything — what core no longer heard of.
    const first = world()
    await runDeploy(contextOf(first))
    const sealed = (
      await sealBackup(
        {
          releaseId,
          deployAttempt: 1,
          files: [],
          records: [priorTitle, optionState('Цветы у дома')],
          folders: [],
        },
        key,
      )
    ).sealed
    const backupUrl = 'https://s3.example.test/raditi-backups/1/backup.tar.zst.enc'
    const second = world(
      manifestOf({
        deployAttempt: 2,
        contentEpoch: 6,
        rollbackOf: {
          deployAttempt: 1,
          backup: {
            method: 'GET',
            url: backupUrl,
            headers: {},
            expiresAt: '2026-10-18T21:00:00.000Z',
          },
          sha256: sha256Hex(sealed),
          sizeBytes: sealed.byteLength,
        },
      }),
    )
    second.content = first.content
    second.db = first.db
    second.values.set(backupUrl, Buffer.from(sealed))
    return second
  }

  it('raises the fence first, then finds the page by the receipt of its creation', async () => {
    const w = await leftByAttemptOne()
    expect(w.db.created.get('page:900')?.trashed).toBe(false)
    const writes = w.db.log.length
    expect(await deploy(contextOf(w, 2))).toBe('rolled_back')
    // The fence of attempt 2 came before anything was read or written.
    expect(w.db.fences).toEqual([6])
    expect(w.db.log.slice(writes)).toEqual([
      'restore post_trash page:900',
      'restore option_update option:blogdescription',
    ])
    expect(w.db.created.get('page:900')?.trashed).toBe(true)
    expect(w.content.records.get('page:42')).toEqual(priorTitle)
    expect(w.db.tables.get('table:bookings')?.exists).toBe(true)
    // A write of attempt 1 still on its way can no longer land.
    const late = await w.db.writeObject({
      callId: '0196abcd-0000-7000-8000-0000000000ff',
      siteId,
      epoch: 5,
      requestHash: 'b'.repeat(64),
      objectRef: 'page:1000000002',
      expectedStateHash: absentHashOf('page:1000000002'),
      deadlineAt: w.clock.now + 60_000,
      ttlMs: 60_000,
      mode: 'release',
      change: {
        kind: 'post_create',
        record: { ...page, slug: 'late' },
        createCallId: '0196abcd-0000-7000-8000-0000000000ff',
      },
    })
    expect(late).toMatchObject({ kind: 'rejected', code: 'fenced' })
  })

  it('knows a page that was never created: no receipt after the fence', async () => {
    const w = await leftByAttemptOne()
    // Attempt 1's creation never landed: its record and receipt are not there.
    const mark = contentCallId(releaseId, 1, 'page:1000000001', 'apply')
    w.db.receipts.delete(mark)
    w.db.created.delete('page:900')
    expect(await deploy(contextOf(w, 2))).toBe('rolled_back')
    expect(w.db.log.some((line) => line.includes('post_trash'))).toBe(false)
  })

  it('ends unknown when the plugin does not raise its fence', async () => {
    const w = await leftByAttemptOne()
    w.db.fence = async () => {
      throw new Error('unavailable')
    }
    expect(await deploy(contextOf(w, 2))).toBe('unknown')
    expect(w.api.sequence).toEqual(['rollback started', 'rollback unknown content_unavailable'])
  })
})

/** The hash rules the job and the plugin share, for the record. */
describe('the state a value leads to', () => {
  it('is the hash of the record under the reference production gave it', () => {
    expect(createdHashOf('page:900', page)).toBe(createdState('page:900', page).stateHash)
    expect(createdHashOf('page:900', page)).not.toBe(createdPreview.stateHash)
    const record: PublishedContentState = createdState('page:900', page)
    expect(record.slug).toBe('prices')
  })
})
