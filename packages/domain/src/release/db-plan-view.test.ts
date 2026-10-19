import { describe, expect, it } from 'vitest'

import type { DbObjectState, DbSetting, TableDefinition } from './db-objects.ts'
import {
  buildDbPlanView,
  DB_PLAN_VIEW_MAX_BYTES,
  dbPlanViewSchema,
  decodeHtmlReferences,
  diffTokens,
  markupLinks,
  markupText,
  type DbPlanViewInput,
  DB_PLAN_BULK_OBJECTS,
  dbPlanViewNeedsReview,
  dbPlanViewRefusal,
  dbPlanViewTexts,
  type DbPlanView,
} from './db-plan-view.ts'
import type { DbOperation } from './db-plan.ts'

const hash = (c: string) => c.repeat(64)
const value = (name: string) => ({
  key: `tasks/t/db/${name}.json`,
  sha256: hash('e'),
  sizeBytes: 9,
})
const record = (
  objectRef: string,
  fields: { title?: string; content?: string; excerpt?: string },
) =>
  ({
    version: 1,
    objectRef,
    kind: objectRef.startsWith('page') ? 'page' : 'post',
    title: '',
    content: '',
    excerpt: '',
    stateHash: hash('a'),
    ...fields,
  }) as DbObjectState
const operation = (kind: DbOperation['kind'], objectRef: string): DbOperation =>
  ({
    kind,
    objectRef,
    fields:
      kind === 'content_update'
        ? ['title', 'content']
        : kind === 'option_update'
          ? ['value']
          : kind === 'schema_migration'
            ? ['definition']
            : ['title', 'content', 'excerpt'],
    beforeHash: hash('a'),
    afterHash: hash('b'),
    before: value('b'),
    after: value('a'),
  }) as DbOperation
const settings: DbSetting[] = [
  {
    option: 'blogname',
    setting: 'title',
    label: 'Название сайта',
    value: 'text',
    maxBytes: 200,
    display: 'html_text',
  },
]
const input = (operations: DbPlanViewInput['operations']): DbPlanViewInput => ({
  planSha256: hash('c'),
  operations,
  settings,
  holdsVariable: (text) => text.includes('sk_live_'),
})

describe('text and links of markup', () => {
  it('reads what a visitor reads, whatever the markup and its comments', () => {
    expect(markupText('<!-- block -->\n<p>Цены &amp; <b>сроки</b>&nbsp;—</p>')).toBe(
      'Цены & сроки —',
    )
    expect(markupText('<script>alert(1)</script>Текст')).toBe('Текст')
    expect(decodeHtmlReferences('&#1062;&#x432;&laquo;&unknown;')).toBe('Цв«&unknown;')
  })

  it('finds every address a fragment links or loads', () => {
    expect(
      markupLinks(`<a href="/prices/">x</a><img src='/a.png'><a href=https://x.test/?a=1&amp;b=2>`),
    ).toEqual(['/prices/', '/a.png', 'https://x.test/?a=1&b=2'])
    // What a filter of posts keeps beyond `href` and `src`, and a block of the editor in a
    // comment: none of it is shown as text.
    expect(
      markupLinks(
        [
          '<p style="color:red;background-image:url(&quot;https://collector.example/p.gif&quot;)">a</p>',
          `<p style='background:url(//cdn.example/b.png)'>b</p>`,
          '<video poster="https://media.example/poster.jpg"></video>',
          '<img longdesc="https://desc.example/" srcset="/s.png 1x, https://big.example/s.png 2x">',
          '<blockquote cite="https://quote.example/"></blockquote><del cite="/why"></del>',
          '<img data-src="https://lazy.example/i.png" data-size="large" data-x="a:b">',
          '<!-- wp:embed {"url":"https:\\/\\/attacker.example\\/x"} /-->',
          '<!-- note https://comment.example/y -->',
        ].join(''),
      ),
    ).toEqual([
      'https://media.example/poster.jpg',
      'https://desc.example/',
      'https://quote.example/',
      '/why',
      '/s.png',
      'https://big.example/s.png',
      'https://lazy.example/i.png',
      'https://collector.example/p.gif',
      '//cdn.example/b.png',
      'https://attacker.example/x',
      'https://comment.example/y',
    ])
    expect(markupLinks('<p data-wide="1" class="x">Текст href без адреса</p>')).toEqual([])
  })
})

describe('diffTokens', () => {
  it('turns one list into the other with the shortest script (seeded property)', () => {
    let state = 7
    const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648
    for (let round = 0; round < 300; round++) {
      const alphabet = ['a', 'b', 'c', ' ']
      const list = (length: number) =>
        Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]!)
      const a = list(Math.floor(next() * 12))
      const b = list(Math.floor(next() * 12))
      const script = diffTokens(a, b)!
      expect(script.filter((step) => step.op !== 'add').map((step) => step.token)).toEqual(a)
      expect(script.filter((step) => step.op !== 'del').map((step) => step.token)).toEqual(b)
    }
  })

  it('gives up on a text changed more than it looks for', () => {
    const a = Array.from({ length: 50 }, (_, at) => `a${at}`)
    const b = Array.from({ length: 50 }, (_, at) => `b${at}`)
    expect(diffTokens(a, b, 10)).toBeNull()
  })
})

describe('buildDbPlanView', () => {
  it('shows a text change by words with context, and its links', () => {
    const before = record('page:42', {
      title: 'Контакты',
      content: `<p>${'слово '.repeat(40)}Адрес: ул. Ленина</p><a href="/old/">x</a>`,
    })
    const after = record('page:42', {
      title: 'Контакты и адрес',
      content: `<p>${'слово '.repeat(40)}Адрес: ул. Мира</p><a href="/new/">x</a>`,
    })
    const view = buildDbPlanView(
      input([{ operation: operation('content_update', 'page:42'), before, after }]),
    )
    expect(dbPlanViewSchema.parse(view)).toEqual(view)
    const card = view.operations[0]!
    if (!('content' in card) || !card.content || !card.title) throw new Error('a text card')
    expect(card.title).toEqual({
      before: 'Контакты',
      after: 'Контакты и адрес',
      markupOnly: false,
      links: { added: [], removed: [] },
      truncated: false,
    })
    expect(card.content.hunks!.map((hunk) => hunk.op)).toEqual([
      'gap',
      'same',
      'del',
      'add',
      'same',
    ])
    expect(card.content.hunks!.find((hunk) => hunk.op === 'add')!.text).toBe('Мира')
    expect(card.content.links).toEqual({ added: ['/new/'], removed: ['/old/'] })
    expect(card.content.markupOnly).toBe(false)
  })

  it('shows the links an excerpt adds, and a change of its markup alone', () => {
    const excerptOnly = { ...operation('content_update', 'page:42'), fields: ['excerpt'] }
    const view = buildDbPlanView(
      input([
        {
          operation: excerptOnly as DbOperation,
          before: record('page:42', { excerpt: 'Свежие цветы каждый день' }),
          after: record('page:42', {
            excerpt: 'Свежие <a href="https://phish.example/">цветы</a> каждый день',
          }),
        },
      ]),
    )
    const card = view.operations[0]!
    if (!('excerpt' in card) || !card.excerpt) throw new Error('an excerpt card')
    expect(card.excerpt).toMatchObject({
      before: 'Свежие цветы каждый день',
      after: 'Свежие цветы каждый день',
      markupOnly: true,
      links: { added: ['https://phish.example/'], removed: [] },
    })
  })

  it('lists the addresses a new page loads from its title, excerpt and text', () => {
    const view = buildDbPlanView(
      input([
        {
          operation: operation('post_create', 'page:1000000001'),
          before: { version: 1, objectRef: 'page:1000000001', absent: true, stateHash: hash('a') },
          after: {
            ...(record('page:1000000001', {
              title: 'Цены',
              excerpt: '<a href="/sale/">Скидки</a>',
              content: '<p style="background:url(https://collector.example/p.gif)">Букеты</p>',
            }) as object),
            status: 'publish',
            slug: 'prices',
          } as DbObjectState,
        },
      ]),
    )
    expect(view.operations[0]).toMatchObject({
      links: ['/sale/', 'https://collector.example/p.gif'],
    })
  })

  it('says a change of markup alone', () => {
    const view = buildDbPlanView(
      input([
        {
          operation: operation('content_update', 'page:42'),
          before: record('page:42', { content: '<p>Текст</p>' }),
          after: record('page:42', { content: '<p><strong>Текст</strong></p>' }),
        },
      ]),
    )
    const card = view.operations[0]!
    expect('content' in card && card.content?.markupOnly).toBe(true)
  })

  it('shows a setting as a reader reads it, a creation and a migration', () => {
    const definition: TableDefinition = {
      columns: [{ name: 'name', type: 'string', length: 120, nullable: false }],
      indexes: [],
    }
    const table = (exists: boolean, given: TableDefinition | null) =>
      ({
        version: 1,
        objectRef: 'table:bookings',
        exists,
        managed: exists,
        definition: given,
        stateHash: hash('a'),
      }) as DbObjectState
    const view = buildDbPlanView(
      input([
        {
          operation: operation('schema_migration', 'table:bookings'),
          before: table(false, null),
          after: table(true, definition),
        },
        {
          operation: operation('option_update', 'option:blogname'),
          before: {
            version: 1,
            objectRef: 'option:blogname',
            value: 'Цветы &amp; Co',
            stateHash: hash('a'),
          },
          after: {
            version: 1,
            objectRef: 'option:blogname',
            value: 'Цветы у дома',
            stateHash: hash('b'),
          },
        },
        {
          operation: operation('post_create', 'page:1000000001'),
          before: { version: 1, objectRef: 'page:1000000001', absent: true, stateHash: hash('a') },
          after: {
            ...(record('page:1000000001', {
              title: 'Цены',
              content: '<p>Букеты</p><a href="/c/">c</a>',
            }) as object),
            status: 'draft',
            slug: 'prices',
          } as DbObjectState,
        },
      ]),
    )
    expect(view.operations).toEqual([
      expect.objectContaining({
        kind: 'schema_migration',
        table: 'bookings',
        created: true,
        columns: definition.columns,
      }),
      expect.objectContaining({
        label: 'Название сайта',
        before: 'Цветы & Co',
        after: 'Цветы у дома',
      }),
      expect.objectContaining({
        title: 'Цены',
        slug: 'prices',
        status: 'draft',
        contentText: 'Букеты c',
        links: ['/c/'],
      }),
    ])
  })

  it('holds no value of an operation that holds a variable of the client', () => {
    const view = buildDbPlanView(
      input([
        {
          operation: operation('content_update', 'page:42'),
          before: record('page:42', { content: 'old' }),
          after: record('page:42', { content: 'key sk_live_123' }),
        },
      ]),
    )
    expect(view.operations).toEqual([
      { kind: 'content_update', index: 0, objectRef: 'page:42', refused: 'client_variable' },
    ])
    expect(JSON.stringify(view)).not.toContain('sk_live_')
  })

  it("holds no variable written as a new page's address or a table's names", () => {
    // Values that pass for an address and for a name of the dictionary.
    const uuid = '3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b'
    const hex = 'deadbeefcafe0042'
    const table = (definition: TableDefinition | null, name = 'bookings') =>
      ({
        version: 1,
        objectRef: `table:${name}`,
        exists: definition !== null,
        managed: definition !== null,
        definition,
        stateHash: hash('a'),
      }) as DbObjectState
    const column = (name: string) => ({ name, type: 'integer' as const, nullable: true })
    const tables = [
      [table(null), table({ columns: [column(hex)], indexes: [] })],
      [
        table(null),
        table({ columns: [column('n')], indexes: [{ name: hex, columns: ['n'], unique: false }] }),
      ],
      [table(null, hex), table({ columns: [column('n')], indexes: [] }, hex)],
    ] as const
    const view = buildDbPlanView({
      ...input([
        {
          operation: operation('post_create', 'page:1000000001'),
          before: { version: 1, objectRef: 'page:1000000001', absent: true, stateHash: hash('a') },
          after: {
            ...(record('page:1000000001', { title: 'Карта' }) as object),
            status: 'publish',
            slug: uuid,
          } as DbObjectState,
        },
        ...tables.map(([before, after]) => ({
          operation: operation('schema_migration', after.objectRef),
          before,
          after,
        })),
      ]),
      holdsVariable: (text) => text.includes(uuid) || text.includes(hex),
    })
    expect(view.operations.map((card) => 'refused' in card && card.refused)).toEqual([
      'client_variable',
      'client_variable',
      'client_variable',
      'client_variable',
    ])
    expect(JSON.stringify(view)).not.toContain(uuid)
    expect(JSON.stringify(view)).not.toContain(hex)
  })

  it('refuses more added links than a card says, instead of cutting them', () => {
    const links = Array.from({ length: 501 }, (_, at) => `<a href="/p${at}/">p</a>`).join('')
    const view = buildDbPlanView(
      input([
        {
          operation: operation('content_update', 'page:42'),
          before: record('page:42', { content: '' }),
          after: record('page:42', { content: links }),
        },
      ]),
    )
    expect(view.operations[0]).toMatchObject({ refused: 'too_many_links' })
  })

  it('keeps a card for each of 200 large operations and says what it shortened', () => {
    const text = (seed: string) =>
      `<p>${Array.from({ length: 2600 }, (_, at) => `${seed}${at % 97}`).join(' ')}</p>`
    const operations = Array.from({ length: 200 }, (_, at) => ({
      operation: operation('content_update', `page:${at + 1}`),
      before: record(`page:${at + 1}`, { title: 'т'.repeat(400), content: text('а') }),
      after: record(`page:${at + 1}`, { title: 'з'.repeat(400), content: text('б') }),
    }))
    const view = buildDbPlanView(input(operations))
    expect(view.oversize).toBe(false)
    expect(view.operations).toHaveLength(200)
    expect(view.truncated).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(view)).byteLength).toBeLessThanOrEqual(
      DB_PLAN_VIEW_MAX_BYTES,
    )
    // The largest plan compared word by word, at every level: about a second alone, several
    // beside the other suites of `pnpm gates`.
  }, 30_000)

  it('refuses a table change that is not an addition', () => {
    const definition: TableDefinition = {
      columns: [{ name: 'name', type: 'string', length: 120, nullable: true }],
      indexes: [],
    }
    const state = (given: TableDefinition) =>
      ({
        version: 1,
        objectRef: 'table:bookings',
        exists: true,
        managed: true,
        definition: given,
        stateHash: hash('a'),
      }) as DbObjectState
    const view = buildDbPlanView(
      input([
        {
          operation: operation('schema_migration', 'table:bookings'),
          before: state(definition),
          after: state({ columns: [{ ...definition.columns[0]!, length: 10 }], indexes: [] }),
        },
      ]),
    )
    expect(view.operations[0]).toMatchObject({ refused: 'not_additive' })
  })
})

describe('which description lets a plan be released', () => {
  it('refuses a plan whose description is missing, not of it, too large or refused a card', () => {
    const plan = { sha256: hash('c'), operations: 1 }
    const shown = buildDbPlanView(
      input([
        {
          operation: operation('option_update', 'option:blogname'),
          before: { version: 1, objectRef: 'option:blogname', value: 'А', stateHash: hash('a') },
          after: { version: 1, objectRef: 'option:blogname', value: 'Б', stateHash: hash('b') },
        },
      ]),
    )
    expect(dbPlanViewRefusal(shown, plan)).toBeNull()
    expect(dbPlanViewRefusal(null, { sha256: hash('c'), operations: 0 })).toBeNull()
    expect(dbPlanViewRefusal(null, plan)).toBe('values_unavailable')
    expect(dbPlanViewRefusal({ ...shown, planSha256: hash('d') }, plan)).toBe('values_unavailable')
    expect(dbPlanViewRefusal(shown, { ...plan, operations: 2 })).toBe('values_unavailable')
    expect(dbPlanViewRefusal({ ...shown, operations: [], oversize: true }, plan)).toBe(
      'values_unavailable',
    )
    const refused = (reason: string) => ({
      ...shown,
      operations: [
        { kind: 'option_update', index: 0, objectRef: 'option:blogname', refused: reason },
      ],
    })
    expect(dbPlanViewRefusal(refused('client_variable'), plan)).toBe('client_variable')
    expect(dbPlanViewRefusal(refused('too_many_links'), plan)).toBe('values_unavailable')
  })
})

describe('what the release window asks of a description', () => {
  it('asks to look at every change of a bulk plan or of a shortened description', () => {
    const view = (operations: number, truncated: boolean): DbPlanView => ({
      v: 1,
      planSha256: 'a'.repeat(64),
      operations: Array.from({ length: operations }, (_, index) => ({
        kind: 'option_update' as const,
        index,
        objectRef: `option:o${index}`,
        label: 'Название сайта',
        before: null,
        after: 'Лавка',
        truncated: false,
      })),
      truncated,
      oversize: false,
    })
    expect(DB_PLAN_BULK_OBJECTS).toBe(20)
    expect(dbPlanViewNeedsReview(view(20, false))).toBe(false)
    expect(dbPlanViewNeedsReview(view(21, false))).toBe(true)
    expect(dbPlanViewNeedsReview(view(1, true))).toBe(true)
    expect(dbPlanViewTexts(view(1, false))).toEqual([
      'a'.repeat(64),
      'option_update',
      'option:o0',
      'Название сайта',
      'Лавка',
    ])
    expect(dbPlanViewTexts({ a: ['x', { b: 'y' }], c: 1, d: null })).toEqual(['x', 'y'])
  })
})
