import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import {
  assertDbOperationAllowed,
  canonicalDbPlanJson,
  compactDbPlan,
  dbOperationKinds,
  dbInverseOf,
  dbInverseWrites,
  dbOperationSchema,
  dbPlanEntryFromJournal,
  dbPlanSchema,
  inverseDbPlan,
  inverseOperation,
  orderDbContentFields,
  type DbContentUpdate,
  type DbJournalOperation,
  type DbJournalRow,
  type DbOperation,
} from './db-plan.ts'

const hash = (c: string) => c.repeat(64)
const ref = (name: string) => ({
  key: `previews/s/p/ops/${name.replace(':', '-')}.enc`,
  sha256: hash('e'),
  sizeBytes: 100,
})
const op = (
  objectRef: string,
  before: string,
  after: string,
  fields: DbContentUpdate['fields'] = ['title'],
): DbContentUpdate => ({
  kind: 'content_update',
  objectRef,
  fields,
  beforeHash: hash(before),
  afterHash: hash(after),
  before: ref(`${objectRef}-${before}`),
  after: ref(`${objectRef}-${after}`),
})

describe('operations', () => {
  it('knows four kinds, the text of a record first: a plan of it alone hashes as before', () => {
    expect(dbOperationKinds).toEqual([
      'content_update',
      'option_update',
      'post_create',
      'schema_migration',
    ])
    expect(dbOperationSchema.parse(op('post:42', 'a', 'b'))).toEqual(op('post:42', 'a', 'b'))
  })

  it('refuses another kind, field or reference, and a value inline', () => {
    const good = op('post:42', 'a', 'b')
    for (const broken of [
      { ...good, kind: 'option_update' },
      { ...good, fields: ['title', 'title'] },
      { ...good, fields: ['post_password'] },
      { ...good, fields: [] },
      { ...good, objectRef: 'option:blogname' },
      { ...good, objectRef: 'post:0' },
      { ...good, objectRef: 'post:42; DROP' },
      { ...good, beforeHash: 'A'.repeat(64) },
      { ...good, after: { ...good.after, key: '../secrets' } },
      { ...good, value: 'Заголовок' },
    ])
      expect(dbOperationSchema.safeParse(broken).success, JSON.stringify(broken)).toBe(false)
  })

  it('throws DB_OPERATION_NOT_ALLOWED for a kind the stack does not declare', () => {
    expect(() => assertDbOperationAllowed('content_update', ['content_update'])).not.toThrow()
    try {
      assertDbOperationAllowed('option_update', ['content_update'])
      expect.unreachable()
    } catch (error) {
      expect(isDomainError(error) && error.code).toBe('DB_OPERATION_NOT_ALLOWED')
    }
  })
})

describe('compactDbPlan', () => {
  it('keeps the first before and the last after of each object, fields of every write', () => {
    const plan = compactDbPlan([
      { operation: op('post:1', 'a', 'b', ['title']), excluded: false },
      { operation: op('post:2', 'd', 'f', ['excerpt']), excluded: false },
      { operation: op('post:1', 'b', 'c', ['content']), excluded: false },
    ])
    expect(plan).toEqual([
      { ...op('post:1', 'a', 'c', ['title', 'content']), after: op('post:1', 'b', 'c').after },
      op('post:2', 'd', 'f', ['excerpt']),
    ])
    expect(dbPlanSchema.safeParse(plan).success).toBe(true)
  })

  it('leaves out excluded writes and objects written back to where they began', () => {
    expect(
      compactDbPlan([
        { operation: op('post:1', 'a', 'b'), excluded: false },
        { operation: op('post:1', 'b', 'z'), excluded: true },
        { operation: op('post:1', 'b', 'a'), excluded: false },
        { operation: op('post:3', 'q', 'r'), excluded: true },
      ]),
    ).toEqual([])
  })

  it('refuses writes of an object that do not chain', () => {
    expect(() =>
      compactDbPlan([
        { operation: op('post:1', 'a', 'b'), excluded: false },
        { operation: op('post:1', 'c', 'd'), excluded: false },
      ]),
    ).toThrow(/does not chain at post:1/)
  })

  it('applied, then inverted in reverse order, brings every object back (seeded property)', () => {
    let state = 5
    const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let round = 0; round < 200; round++) {
      const heads = new Map<string, string>()
      const entries = []
      for (let i = 0; i < 12; i++) {
        const object = `post:${1 + Math.floor(next() * 4)}`
        const before = heads.get(object) ?? `${object}:0`
        const after = `${object}:${round}:${i}`
        const write = {
          ...op(object, 'a', 'b'),
          beforeHash: digest(before),
          afterHash: digest(after),
        }
        const excluded = next() < 0.2
        if (!excluded) heads.set(object, after)
        else continue
        entries.push({ operation: write, excluded })
      }
      const plan = compactDbPlan(entries)
      const site = new Map<string, string>()
      for (const operation of plan) site.set(operation.objectRef, operation.beforeHash)
      const start = new Map(site)
      for (const operation of plan) {
        expect(site.get(operation.objectRef)).toBe(operation.beforeHash)
        site.set(operation.objectRef, operation.afterHash)
      }
      for (const operation of inverseDbPlan(plan)) {
        if (operation.kind !== 'content_update') throw new Error('a text change inverts to one')
        expect(site.get(operation.objectRef)).toBe(operation.beforeHash)
        site.set(operation.objectRef, operation.afterHash)
      }
      expect(site).toEqual(start)
    }
  })
})

/** A stand-in for a state hash: 64 hex characters derived from a text. */
function digest(text: string): string {
  let h = 0
  for (const char of text) h = (Math.imul(h, 31) + char.charCodeAt(0)) | 0
  return (h >>> 0).toString(16).padStart(8, '0').repeat(8)
}

describe('inverseOperation', () => {
  it('swaps the sides and takes the receipt as its precondition', () => {
    const write = op('post:7', 'a', 'b', ['title', 'content'])
    expect(inverseOperation(write)).toEqual({
      ...write,
      beforeHash: hash('b'),
      afterHash: hash('a'),
      before: write.after,
      after: write.before,
    })
    expect(inverseOperation(write, hash('f')).beforeHash).toBe(hash('f'))
    expect(inverseOperation(inverseOperation(write))).toEqual(write)
  })

  it('hashes a plan over one text whatever the key order', () => {
    const write = op('post:7', 'a', 'b', ['content', 'title'])
    const shuffled: DbContentUpdate = {
      after: write.after,
      before: write.before,
      afterHash: write.afterHash,
      beforeHash: write.beforeHash,
      fields: ['title', 'content'],
      objectRef: write.objectRef,
      kind: write.kind,
    }
    expect(canonicalDbPlanJson([write])).toBe(canonicalDbPlanJson([shuffled]))
  })
})

describe('the journal of a preview', () => {
  const row = (extra: Partial<DbJournalRow> = {}): DbJournalRow => ({
    kind: 'content_update',
    objectRef: 'post:42',
    fields: ['title', 'excerpt'],
    beforeHash: hash('a'),
    afterHash: hash('b'),
    beforeObjectKey: 'previews/s/p/ops/1-before.enc',
    beforeSha256: hash('c'),
    beforeBytes: 120,
    afterObjectKey: 'previews/s/p/ops/1-after.enc',
    afterSha256: hash('d'),
    afterBytes: 140,
    excluded: false,
    ...extra,
  })

  it('rebuilds an operation of the plan from the stored columns alone', () => {
    const entry = dbPlanEntryFromJournal(row())
    expect(entry).toEqual({
      excluded: false,
      operation: {
        kind: 'content_update',
        objectRef: 'post:42',
        fields: ['title', 'excerpt'],
        beforeHash: hash('a'),
        afterHash: hash('b'),
        before: { key: 'previews/s/p/ops/1-before.enc', sha256: hash('c'), sizeBytes: 120 },
        after: { key: 'previews/s/p/ops/1-after.enc', sha256: hash('d'), sizeBytes: 140 },
      },
    })
    expect(
      compactDbPlan([entry, dbPlanEntryFromJournal(row({ objectRef: 'page:7' }))]),
    ).toHaveLength(2)
  })

  it('refuses a row that is not an operation as a conflict', () => {
    for (const broken of [
      row({ kind: 'option_update' }),
      row({ fields: ['post_password'] }),
      row({ beforeBytes: 0 }),
      row({ afterSha256: 'x' }),
    ]) {
      try {
        dbPlanEntryFromJournal(broken)
        expect.unreachable()
      } catch (error) {
        expect(isDomainError(error) && error.code).toBe('CONFLICT')
      }
    }
  })

  it('stores the fields in one order', () => {
    expect(orderDbContentFields(['excerpt', 'title', 'excerpt'])).toEqual(['title', 'excerpt'])
  })
})

describe('the kinds of a plan beyond the text of a record', () => {
  const side = (name: string) => ({
    key: `tasks/t/db/${name.replace(':', '-')}.json`,
    sha256: hash('e'),
    sizeBytes: 90,
  })
  const write = <Kind extends DbJournalOperation['kind']>(
    kind: Kind,
    objectRef: string,
    before: string,
    after: string,
  ) =>
    ({
      kind,
      objectRef,
      fields:
        kind === 'content_update'
          ? ['title']
          : kind === 'option_update'
            ? ['value']
            : kind === 'schema_migration'
              ? ['definition']
              : kind === 'post_trash'
                ? []
                : ['title', 'content', 'excerpt'],
      beforeHash: hash(before),
      afterHash: hash(after),
      before: side(`${objectRef}-${before}`),
      after: side(`${objectRef}-${after}`),
    }) as DbJournalOperation
  const entry = (operation: DbJournalOperation, excluded = false) => ({ operation, excluded })
  const created = 'page:1000000001'

  it('folds later writes of a created record into its creation', () => {
    const plan = compactDbPlan([
      entry(write('post_create', created, '0', '1')),
      entry(write('content_update', created, '1', '2')),
    ])
    expect(plan).toEqual([
      {
        ...write('post_create', created, '0', '2'),
        after: side(`${created}-2`),
        before: side(`${created}-0`),
      },
    ])
    expect(dbPlanSchema.safeParse(plan).success).toBe(true)
  })

  it('drops a record created and taken out again, however many writes it had', () => {
    expect(
      compactDbPlan([
        entry(write('post_create', created, '0', '1')),
        entry(write('content_update', created, '1', '2')),
        entry(write('post_trash', created, '2', '0')),
      ]),
    ).toEqual([])
  })

  it('refuses a created record without its creation and writes around a creation', () => {
    for (const entries of [
      [entry(write('content_update', created, '1', '2'))],
      [entry(write('post_trash', created, '1', '0'))],
      // The creation was excluded with its turn; the record is not in the preview any more.
      [
        entry(write('post_create', created, '0', '1'), true),
        entry(write('content_update', created, '1', '2')),
      ],
      [
        entry(write('post_create', created, '0', '1')),
        entry(write('post_create', created, '1', '2')),
      ],
      [
        entry(write('post_create', created, '0', '1')),
        entry(write('post_trash', created, '1', '0')),
        entry(write('content_update', created, '0', '3')),
      ],
      // A setting and a text of one reference cannot share a chain.
      [entry(write('post_create', 'page:42', '0', '1'))],
    ])
      expect(() => compactDbPlan(entries)).toThrow()
  })

  it('keeps a setting and a table by their ends, and drops them when they came back', () => {
    const plan = compactDbPlan([
      entry(write('option_update', 'option:blogname', 'a', 'b')),
      entry(write('schema_migration', 'table:bookings', 'x', 'y')),
      entry(write('option_update', 'option:blogname', 'b', 'c')),
      entry(write('option_update', 'option:blogdescription', 'd', 'e')),
      entry(write('option_update', 'option:blogdescription', 'e', 'd')),
    ])
    expect(plan.map((operation) => [operation.kind, operation.objectRef])).toEqual([
      ['schema_migration', 'table:bookings'],
      ['option_update', 'option:blogname'],
    ])
    expect(plan[1]!.afterHash).toBe(hash('c'))
  })

  it('orders a plan by kind, then by the first write of each object', () => {
    const plan = compactDbPlan([
      entry(write('content_update', 'page:9', 'a', 'b')),
      entry(write('post_create', created, '0', '1')),
      entry(write('option_update', 'option:blogname', 'a', 'b')),
      entry(write('content_update', 'post:3', 'a', 'b')),
      entry(write('schema_migration', 'table:bookings', 'a', 'b')),
      entry(write('post_create', 'post:1000000002', '0', '1')),
    ])
    expect(plan.map((operation) => operation.objectRef)).toEqual([
      'table:bookings',
      'option:blogname',
      created,
      'post:1000000002',
      'page:9',
      'post:3',
    ])
    expect(dbPlanSchema.safeParse(plan).success).toBe(true)
    expect(dbPlanSchema.safeParse([...plan].reverse()).success).toBe(false)
  })

  it('refuses a plan that holds a trash, a created text change or too many tables', () => {
    const tables = Array.from({ length: 9 }, (_, at) =>
      write('schema_migration', `table:t${at}`, 'a', 'b'),
    )
    for (const plan of [
      [write('post_trash', created, '1', '0')],
      [{ ...write('content_update', created, '1', '2') }],
      [{ ...write('option_update', 'option:blogname', 'a', 'b'), fields: ['title'] }],
      [{ ...write('content_update', 'option:5', 'a', 'b') }],
      tables,
    ])
      expect(dbPlanSchema.safeParse(plan).success, JSON.stringify(plan[0])).toBe(false)
  })

  it('reads journal rows of every kind back', () => {
    for (const operation of [
      write('option_update', 'option:blogname', 'a', 'b'),
      write('post_create', created, '0', '1'),
      write('post_trash', created, '1', '0'),
      write('schema_migration', 'table:bookings', 'a', 'b'),
      write('content_update', created, '1', '2'),
    ])
      expect(
        dbPlanEntryFromJournal({
          kind: operation.kind,
          objectRef: operation.objectRef,
          fields: operation.fields,
          beforeHash: operation.beforeHash,
          afterHash: operation.afterHash,
          beforeObjectKey: operation.before.key,
          beforeSha256: operation.before.sha256,
          beforeBytes: operation.before.sizeBytes,
          afterObjectKey: operation.after.key,
          afterSha256: operation.after.sha256,
          afterBytes: operation.after.sizeBytes,
          excluded: false,
        }).operation,
      ).toEqual(operation)
  })

  it('returns a value, takes a created record out while it holds the release, keeps a table', () => {
    const option = write('option_update', 'option:blogname', 'a', 'b') as DbOperation
    expect(dbInverseOf(option)).toMatchObject({ kind: 'option_update', beforeHash: hash('b') })
    const creation = write('post_create', created, '0', '1') as DbOperation
    const trash = dbInverseOf(creation, { appliedHash: hash('f'), productionRef: 'page:812' })
    expect(trash).toEqual({
      kind: 'post_trash',
      objectRef: created,
      productionRef: 'page:812',
      expectedStateHash: hash('f'),
    })
    const table = dbInverseOf(write('schema_migration', 'table:bookings', 'a', 'b') as DbOperation)
    expect(table).toEqual({ kind: 'kept', objectRef: 'table:bookings' })
    expect([trash, table].map(dbInverseWrites)).toEqual([true, false])
    expect(canonicalDbPlanJson([option])).toContain('"fields":["value"]')
  })
})
