import { describe, expect, it } from 'vitest'

import { confirmTokenMaterial, undoConfirmTokenMaterial } from './confirm-token.ts'
import {
  canonicalDbUndoPlanJson,
  dbUndoPlanSchema,
  deployDbOperationSchema,
  undoOperationOf,
  type DbOperation,
  type DbProductionTrash,
} from './db-plan.ts'
import { deployManifestSchema, deployValueAad, deployValueSchemas } from './deploy-manifest.ts'
import { releaseKeyMaterial, undoKeyMaterial } from './release-key.ts'
import { releaseTaskEffects, releaseTaskEffectsOf } from './release-state.ts'
import {
  classifyUndoOperation,
  undoDeadline,
  undoExpired,
  undoFilesSummarySchema,
  undoPlanMaterial,
  undoRecordCounts,
  UNDO_WINDOW_MS,
} from './undo.ts'

const hash = (char: string) => char.repeat(64)
const value = (char: string) => ({ key: `tasks/t/db/${char}`, sha256: hash(char), sizeBytes: 10 })
const text: DbOperation = {
  kind: 'content_update',
  objectRef: 'page:42',
  fields: ['title'],
  beforeHash: hash('a'),
  afterHash: hash('b'),
  before: value('1'),
  after: value('2'),
}
const setting: DbOperation = {
  kind: 'option_update',
  objectRef: 'option:blogdescription',
  fields: ['value'],
  beforeHash: hash('c'),
  afterHash: hash('d'),
  before: value('3'),
  after: value('4'),
}
const page: DbOperation = {
  kind: 'post_create',
  objectRef: 'page:1000000001',
  fields: ['title', 'content', 'excerpt'],
  beforeHash: hash('e'),
  afterHash: hash('f'),
  before: value('5'),
  after: value('6'),
}
const table: DbOperation = {
  kind: 'schema_migration',
  objectRef: 'table:bookings',
  fields: ['definition'],
  beforeHash: hash('7'),
  afterHash: hash('8'),
  before: value('7'),
  after: value('8'),
}

describe('the seven days of an undo', () => {
  it('counts seven times 24 hours from the installation', () => {
    const installed = new Date('2026-10-18T10:00:00Z')
    expect(UNDO_WINDOW_MS).toBe(604_800_000)
    expect(undoDeadline(installed).toISOString()).toBe('2026-10-25T10:00:00.000Z')
    expect(undoExpired(installed, new Date('2026-10-25T09:59:59Z'))).toBe(false)
    expect(undoExpired(installed, new Date('2026-10-25T10:00:00Z'))).toBe(true)
  })
})

describe('the writes of an undo', () => {
  it('puts a text and a setting back with their sides swapped', () => {
    expect(undoOperationOf(text)).toEqual({
      ...text,
      beforeHash: text.afterHash,
      afterHash: text.beforeHash,
      before: text.after,
      after: text.before,
    })
    expect(undoOperationOf(setting)).toMatchObject({
      kind: 'option_update',
      beforeHash: hash('d'),
      afterHash: hash('c'),
    })
  })

  it('takes a new record to the trash under the reference production gave it', () => {
    const trash = undoOperationOf(page, {
      productionRef: 'page:812',
      stateHash: hash('9'),
      absentHash: hash('0'),
    })
    expect(trash).toEqual({
      kind: 'post_trash',
      objectRef: 'page:812',
      createdRef: 'page:1000000001',
      fields: [],
      beforeHash: hash('9'),
      afterHash: hash('0'),
      before: page.after,
      after: page.before,
    })
    // Without what production gave it, there is nothing to take out: the record is never
    // addressed by the reference of the preview.
    expect(undoOperationOf(page)).toBeNull()
  })

  it('writes nothing for a table: the structure stays', () => {
    expect(undoOperationOf(table)).toBeNull()
  })

  it('refuses a trash of a reference of the plan and two writes of one object', () => {
    const trash = undoOperationOf(page, {
      productionRef: 'page:812',
      stateHash: hash('9'),
      absentHash: hash('0'),
    })!
    expect(dbUndoPlanSchema.safeParse([undoOperationOf(text), trash]).success).toBe(true)
    expect(dbUndoPlanSchema.safeParse([{ ...trash, objectRef: 'page:1000000001' }]).success).toBe(
      false,
    )
    expect(dbUndoPlanSchema.safeParse([undoOperationOf(text), undoOperationOf(text)]).success).toBe(
      false,
    )
    // A release's operation is not a write of an undo, and an undo's trash is not one of a plan.
    expect(dbUndoPlanSchema.safeParse([page]).success).toBe(false)
    expect(deployDbOperationSchema.safeParse(trash).success).toBe(true)
  })

  it('hashes the plan of an undo over a fixed text that names the plan’s record', () => {
    const trash = undoOperationOf(page, {
      productionRef: 'page:812',
      stateHash: hash('9'),
      absentHash: hash('0'),
    }) as DbProductionTrash
    const json = canonicalDbUndoPlanJson([trash])
    expect(JSON.parse(json)[0]).toMatchObject({
      kind: 'post_trash',
      objectRef: 'page:812',
      createdRef: 'page:1000000001',
    })
    expect(canonicalDbUndoPlanJson([{ ...trash, createdRef: 'page:1000000002' }])).not.toBe(json)
  })
})

describe('the verdict of each object', () => {
  const written = hash('b')
  const prior = hash('a')

  it('returns a text or a setting only from what the release wrote', () => {
    for (const kind of ['content_update', 'option_update'] as const) {
      expect(classifyUndoOperation({ kind, written, prior, current: written })).toBe('return')
      expect(classifyUndoOperation({ kind, written, prior, current: prior })).toBe('already')
      expect(classifyUndoOperation({ kind, written, prior, current: hash('x') })).toBe('changed')
      expect(classifyUndoOperation({ kind, written, prior, current: 'absent' })).toBe('missing')
    }
  })

  it('takes a new record out only unchanged and with nothing standing on it', () => {
    const kind = 'post_create'
    expect(classifyUndoOperation({ kind, written, prior, current: written })).toBe('return')
    expect(classifyUndoOperation({ kind, written, prior, current: written, dependents: 2 })).toBe(
      'kept_dependents',
    )
    expect(classifyUndoOperation({ kind, written, prior, current: hash('x') })).toBe('changed')
    expect(classifyUndoOperation({ kind, written, prior, current: 'absent' })).toBe('missing')
  })

  it('keeps a table as it is', () => {
    expect(
      classifyUndoOperation({ kind: 'schema_migration', written, prior, current: written }),
    ).toBe('stays')
  })

  it('counts what returns and what the site changed since', () => {
    expect(
      undoRecordCounts([
        { verdict: 'return' },
        { verdict: 'return' },
        { verdict: 'already' },
        { verdict: 'changed' },
        { verdict: 'missing' },
        { verdict: 'kept_dependents' },
        { verdict: 'no_value' },
        { verdict: 'stays' },
      ]),
    ).toEqual({ returned: 2, kept: 4 })
  })
})

describe('the plan the client confirms', () => {
  const facts = {
    releaseId: '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d90',
    installedSha: 'a'.repeat(40),
    targetTree: 'b'.repeat(40),
    files: { back: 1, removed: 0, restored: 0, mediaKept: 0, paths: [] },
    items: [
      {
        objectRef: 'page:42',
        productionRef: null,
        kind: 'content_update' as const,
        fields: ['title'],
        verdict: 'return' as const,
      },
    ],
    dbPlanJson: '[]',
  }

  it('changes its text with any of its facts', () => {
    const base = undoPlanMaterial(facts)
    expect(base.startsWith('["raditi-undo-plan:v1"')).toBe(true)
    expect(undoPlanMaterial({ ...facts, targetTree: 'c'.repeat(40) })).not.toBe(base)
    expect(
      undoPlanMaterial({ ...facts, items: [{ ...facts.items[0]!, verdict: 'changed' }] }),
    ).not.toBe(base)
    expect(undoPlanMaterial({ ...facts, dbPlanJson: '[1]' })).not.toBe(base)
  })

  it('names files by safe paths only', () => {
    expect(
      undoFilesSummarySchema.safeParse({
        ...facts.files,
        paths: [{ path: '../wp-config.php', change: 'back' }],
      }).success,
    ).toBe(false)
  })
})

describe('the confirmation, the key and the values of an undo', () => {
  const claims = {
    userId: '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d91',
    releaseId: '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d92',
    planId: '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d93',
    planSha256: hash('a'),
    version: 'v1.4.1',
    expiresAt: 1_800_000_000,
  }

  it('signs another text than a release’s', () => {
    expect(undoConfirmTokenMaterial(claims).split('\n')[0]).toBe('raditi-undo-confirm:v1')
    expect(
      confirmTokenMaterial({
        userId: claims.userId,
        candidateId: claims.releaseId,
        revision: 1,
        version: claims.version,
        dbViewSha256: null,
        expiresAt: claims.expiresAt,
      }).split('\n')[0],
    ).toBe('raditi-release-confirm:v2')
    expect(
      undoKeyMaterial({
        undoesReleaseId: claims.releaseId,
        planId: claims.planId,
        version: claims.version,
        attempt: 1,
      }).split('\n')[0],
    ).toBe('raditi-undo-key:v1')
    expect(
      releaseKeyMaterial({
        candidateId: claims.releaseId,
        revision: 1,
        version: claims.version,
        attempt: 1,
      }),
    ).not.toContain('undo')
  })

  it('binds a value to the kind of the row', () => {
    const release = deployValueAad(claims.releaseId, 'page:42', hash('a'))
    expect(deployValueAad(claims.releaseId, 'page:42', hash('a'), 'release')).toBe(release)
    expect(deployValueAad(claims.releaseId, 'page:42', hash('a'), 'undo')).not.toBe(release)
  })

  it('reads a setting with no row only as an undo value, and the trash of a record', () => {
    expect(deployValueSchemas.option_update.safeParse({ v: 1, value: null }).success).toBe(true)
    expect(
      deployValueSchemas.post_trash.safeParse({
        v: 1,
        slug: 'offers',
        createCallId: claims.planId,
      }).success,
    ).toBe(true)
  })

  it('leaves the dialog and its credits alone', () => {
    expect(releaseTaskEffectsOf('release', 'installed')).toBe(releaseTaskEffects.installed)
    for (const outcome of ['installed', 'rolled_back', 'failed', 'unknown', 'refused'] as const)
      expect(releaseTaskEffectsOf('undo', outcome)).toEqual({
        ...releaseTaskEffects[outcome],
        steps: [],
        credits: 'none',
      })
  })
})

describe('the manifest of an undo', () => {
  const manifest = {
    v: 1,
    kind: 'undo',
    releaseId: '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d92',
    siteId: '018f3b2e-7c4a-7b1c-9d2e-3f4a5b6c7d93',
    deployAttempt: 1,
    tag: 'v1.4.1',
    installedSha: 'a'.repeat(40),
    approvedSha: 'b'.repeat(40),
    method: 'sftp',
    files: { write: [], delete: [] },
    contentEpoch: 3,
    verify: { origin: 'https://example.ru', failureMarkers: [], pages: ['/'] },
  }
  const after = {
    method: 'GET',
    url: 'https://core.example/v1/releases/x/values/0',
    headers: {},
    expiresAt: '2026-10-18T10:00:00.000Z',
  }
  const trash = undoOperationOf(page, {
    productionRef: 'page:812',
    stateHash: hash('9'),
    absentHash: hash('0'),
  })!

  it('carries the writes of an undo and nothing else', () => {
    expect(
      deployManifestSchema.safeParse({ ...manifest, db: [{ operation: trash, after }] }).success,
    ).toBe(true)
    expect(
      deployManifestSchema.safeParse({ ...manifest, db: [{ operation: page, after }] }).success,
    ).toBe(false)
    expect(
      deployManifestSchema.safeParse({
        ...manifest,
        kind: 'release',
        db: [{ operation: trash, after }],
      }).success,
    ).toBe(false)
    // An older manifest without the kind is a release's.
    const { kind: _kind, ...older } = manifest
    expect(deployManifestSchema.parse({ ...older, db: [] }).kind).toBe('release')
  })
})
