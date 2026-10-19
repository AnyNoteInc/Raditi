import { z } from 'zod'

import {
  contentHashSchema,
  publishedContentHashMaterial,
  publishedContentStateSchema,
} from '../ports/published-content.ts'
import { pluralRu } from '../plural.ts'

// The objects a database plan changes (docs/plan/53-chat-preview-release.md, «Операции БД и
// миграции»): records of the site, its settings and the tables of the platform, each in one
// notation, with one way to say its state — a state hash over byte frames that the site's
// plugin and the platform build the same way. What a stack can change is the adapter's word
// (`SiteAdapter.dbOperationKinds`, `dbSettings`); nothing here knows a stack.

/**
 * The first id the platform gives an object created in a preview — a rule of the platform, not
 * of a CMS. Production's own ids stay below it, so a created object keeps one reference over
 * every rebuild of its preview, and a number of a preview never passes for one of production.
 * A site with ids from here on gets no created objects (`runtime.db.createdIds`).
 */
export const DB_CREATED_ID_BASE = 1_000_000_000
/** Ten digits: the bound of `publishedObjectRefSchema` and of the plugin's routes. */
export const DB_CREATED_ID_MAX = 9_999_999_999

/** Kinds of objects that are not records: their references would read as `<type>:<id>`. */
const reservedTypes = new Set(['option', 'table'])

/** A record of the site in the adapter's notation: `page:42`. */
export const dbRecordRefSchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z_]{0,31}:[1-9]\d{0,18}$/, 'expected <type>:<id>')
  .refine((ref) => !reservedTypes.has(ref.slice(0, ref.indexOf(':'))), 'a reserved type')
/** A setting of the site by its name in the database: `option:blogname`. */
export const dbOptionRefSchema = z.string().regex(/^option:[a-z][a-z0-9_]{0,63}$/)
/**
 * A table of the platform by its name without any prefix: `table:bookings`. The site's
 * plugin puts its own prefix and a namespace of the platform in front of it, so no table of the
 * site's core or of another plugin can be named.
 */
export const dbTableRefSchema = z.string().regex(/^table:[a-z][a-z0-9_]{0,29}$/)
export const dbObjectRefSchema = z.union([dbRecordRefSchema, dbOptionRefSchema, dbTableRefSchema])

export const isOptionRef = (ref: string) => dbOptionRefSchema.safeParse(ref).success
export const isTableRef = (ref: string) => dbTableRefSchema.safeParse(ref).success
export const isRecordRef = (ref: string) => dbRecordRefSchema.safeParse(ref).success
/** The number of a record reference; null for a setting or a table. */
export function recordIdOf(ref: string): number | null {
  if (!isRecordRef(ref)) return null
  const id = Number(ref.slice(ref.indexOf(':') + 1))
  return Number.isSafeInteger(id) ? id : null
}
/** A record the platform created in a preview: its id is at or above DB_CREATED_ID_BASE. */
export function isCreatedRef(ref: string): boolean {
  const id = recordIdOf(ref)
  return id !== null && id >= DB_CREATED_ID_BASE && id <= DB_CREATED_ID_MAX
}
export const recordTypeOf = (ref: string) => ref.slice(0, ref.indexOf(':'))
export const optionNameOf = (ref: string) => ref.slice('option:'.length)
export const tableNameOf = (ref: string) => ref.slice('table:'.length)

/**
 * Whether a text holds the number of a created record as a number of its own — not inside a
 * longer one. A created number means nothing on production, where the record gets another; a
 * page, a style or a template that names it would point at nothing after a release. The rule
 * knows no syntax of any stack: a ten-digit number equal to a given one does not happen by
 * chance.
 */
export function mentionsCreatedId(text: string, ids: Iterable<number>): boolean {
  const numbers = [...new Set(ids)].filter(
    (id) => Number.isSafeInteger(id) && id >= DB_CREATED_ID_BASE,
  )
  if (numbers.length === 0) return false
  return new RegExp(`(?<![0-9])(?:${numbers.join('|')})(?![0-9])`).test(text)
}

// ---------------------------------------------------------------------------------------------
// States and their hashes
// ---------------------------------------------------------------------------------------------

/**
 * Values in a row, each as `<bytes>:<value>` — what `publishedContentHashMaterial` does for a
 * record and the site's plugin does in PHP: no escaping that two languages could do apart.
 */
export function dbHashFrames(values: readonly string[]): string {
  const encoder = new TextEncoder()
  return values.map((value) => `${encoder.encode(value).byteLength}:${value}`).join('')
}

/** A record that is not there: the start of a creation, the end of moving one to the trash. */
export const dbAbsentStateSchema = z.strictObject({
  version: z.literal(1),
  objectRef: dbRecordRefSchema,
  absent: z.literal(true),
  stateHash: contentHashSchema,
})
export type DbAbsentState = z.infer<typeof dbAbsentStateSchema>
export const absentStateHashMaterial = (objectRef: string) => dbHashFrames(['absent', objectRef])

/** The value of a setting as the database keeps it, bytes as they are; null — no row. */
const optionValue = z
  .string()
  .max(32 * 1024)
  .refine((value) => !value.includes('\0'))
export const dbOptionStateSchema = z.strictObject({
  version: z.literal(1),
  objectRef: dbOptionRefSchema,
  value: optionValue.nullable(),
  stateHash: contentHashSchema,
})
export type DbOptionState = z.infer<typeof dbOptionStateSchema>
export const optionStateHashMaterial = (state: Pick<DbOptionState, 'objectRef' | 'value'>) =>
  dbHashFrames(['option', state.objectRef, state.value === null ? '0' : '1', state.value ?? ''])

// ---------------------------------------------------------------------------------------------
// The dictionary of tables: what a schema migration may declare
// ---------------------------------------------------------------------------------------------

/**
 * The types of a column. The site's plugin turns each into the SQL of its database itself; no
 * text of the agent reaches SQL but a checked name or a literal.
 */
export const dbColumnTypes = [
  'string',
  'text',
  'long_text',
  'integer',
  'big_integer',
  'unsigned_big_integer',
  'boolean',
  'decimal',
  'date',
  'datetime',
] as const
export type DbColumnType = (typeof dbColumnTypes)[number]

export const dbTableLimits = Object.freeze({
  columns: 31,
  indexes: 8,
  indexColumns: 4,
  stringLength: 191,
  /** The definition as JSON. */
  definitionBytes: 8 * 1024,
})

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/)
/** `id` is the implicit first column of every table of the platform. */
const columnName = identifier.refine((name) => name !== 'id', 'the implicit id column')

/** A default: a literal in its one spelling, or the time of the insert (only `datetime`). */
const columnDefault = z.union([
  z.strictObject({ value: z.string().max(191 * 4) }),
  z.strictObject({ now: z.literal(true) }),
])

const integerBounds: Partial<Record<DbColumnType, readonly [bigint, bigint]>> = {
  integer: [-2147483648n, 2147483647n],
  big_integer: [-9223372036854775808n, 9223372036854775807n],
  unsigned_big_integer: [0n, 18446744073709551615n],
}
const validDate = (text: string) => {
  const [year, month, day] = text.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day!))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1
}

/** Why the default of a column is not one literal of its type in its one spelling; null — it is. */
function defaultProblem(column: {
  type: DbColumnType
  length?: number | undefined
  precision?: number | undefined
  scale?: number | undefined
  default?: { value: string } | { now: true } | undefined
}): string | null {
  const given = column.default
  if (given === undefined) return null
  if ('now' in given) return column.type === 'datetime' ? null : 'only a datetime defaults to now'
  const value = given.value
  switch (column.type) {
    case 'text':
    case 'long_text':
      return 'a text column has no default'
    case 'string':
      // No control characters and no line or paragraph separators: one spelling everywhere.
      // No control characters, line or paragraph separators, quotes or backslashes: one spelling
      // in every catalog of a server.
      return /[\p{Cc}\u2028\u2029'\\]/u.test(value) || [...value].length > (column.length ?? 0)
        ? 'a string default longer than its column or with characters it may not hold'
        : null
    case 'boolean':
      return value === '0' || value === '1' ? null : 'a boolean default is 0 or 1'
    case 'decimal': {
      const scale = column.scale ?? 0
      const pattern =
        scale === 0 ? /^-?(0|[1-9]\d*)$/ : new RegExp(`^-?(0|[1-9]\\d*)\\.\\d{${scale}}$`)
      const whole = value.replace(/^-/, '').split('.')[0]!
      // The spelling the database reports: every digit of the scale, no negative zero.
      return pattern.test(value) &&
        whole.length <= Math.max(1, (column.precision ?? 0) - scale) &&
        !/^-0(\.0+)?$/.test(value)
        ? null
        : 'a decimal default with exactly its scale of digits'
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && validDate(value) ? null : 'a date as YYYY-MM-DD'
    case 'datetime':
      return /^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value) &&
        validDate(value.slice(0, 10))
        ? null
        : 'a datetime as YYYY-MM-DD HH:MM:SS'
    default: {
      const bounds = integerBounds[column.type]!
      if (!/^-?(0|[1-9]\d{0,19})$/.test(value) || value === '-0') return 'an integer default'
      const number = BigInt(value)
      return number >= bounds[0] && number <= bounds[1] ? null : 'an integer default out of range'
    }
  }
}

export const dbColumnSchema = z
  .strictObject({
    name: columnName,
    type: z.enum(dbColumnTypes),
    /** Characters of a `string`. */
    length: z.number().int().min(1).max(dbTableLimits.stringLength).optional(),
    /** Digits of a `decimal` and how many of them follow the point. */
    precision: z.number().int().min(1).max(18).optional(),
    scale: z.number().int().min(0).max(6).optional(),
    nullable: z.boolean(),
    default: columnDefault.optional(),
  })
  .superRefine((column, context) => {
    const problem = (message: string) => context.addIssue({ code: 'custom', message })
    if ((column.type === 'string') !== (column.length !== undefined))
      problem('a length for a string column alone')
    if ((column.type === 'decimal') !== (column.precision !== undefined))
      problem('a precision for a decimal column alone')
    if ((column.type === 'decimal') !== (column.scale !== undefined))
      problem('a scale for a decimal column alone')
    if (
      column.scale !== undefined &&
      column.precision !== undefined &&
      column.scale > column.precision
    )
      problem('a scale above the precision')
    const wrong = defaultProblem(column)
    if (wrong) problem(wrong)
  })
export type DbColumn = z.infer<typeof dbColumnSchema>

export const dbIndexSchema = z.strictObject({
  name: identifier.refine((name) => name !== 'primary', 'the primary key'),
  columns: z
    .array(identifier)
    .min(1)
    .max(dbTableLimits.indexColumns)
    .refine((list) => new Set(list).size === list.length, 'each column once'),
  unique: z.boolean(),
})
export type DbIndex = z.infer<typeof dbIndexSchema>

const indexable = new Set<DbColumnType>(dbColumnTypes.filter((type) => !type.endsWith('text')))

/**
 * A table of the platform, its implicit `id` aside: columns in their order, indexes by name.
 * One definition has one spelling, so its hash is the same on both sides.
 */
export const tableDefinitionSchema = z
  .strictObject({
    columns: z.array(dbColumnSchema).min(1).max(dbTableLimits.columns),
    indexes: z.array(dbIndexSchema).max(dbTableLimits.indexes),
  })
  .superRefine((definition, context) => {
    const problem = (message: string) => context.addIssue({ code: 'custom', message })
    const types = new Map(definition.columns.map((column) => [column.name, column.type]))
    if (types.size !== definition.columns.length) problem('each column name once')
    const names = definition.indexes.map((index) => index.name)
    if (new Set(names).size !== names.length) problem('each index name once')
    if (names.some((name, at) => at > 0 && names[at - 1]! >= name)) problem('indexes by name')
    for (const index of definition.indexes)
      for (const column of index.columns) {
        const type = types.get(column)
        if (type === undefined) problem('an index of an unknown column')
        else if (!indexable.has(type)) problem('an index of a text column')
      }
    if (
      new TextEncoder().encode(JSON.stringify(definition)).byteLength >
      dbTableLimits.definitionBytes
    )
      problem('a definition above its limit')
  })
export type TableDefinition = z.infer<typeof tableDefinitionSchema>

/** A definition in its one spelling: indexes by name. The order of columns is the table's. */
export function normalizeTableDefinition(definition: TableDefinition): TableDefinition {
  return {
    columns: definition.columns.map((column) => ({ ...column })),
    indexes: [...definition.indexes]
      .map((index) => ({ ...index, columns: [...index.columns] }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  }
}

/** The frames of a definition: every field of every column and index in a fixed order. */
function definitionFrames(definition: TableDefinition): string[] {
  const frames: string[] = []
  for (const column of definition.columns) {
    const given = column.default
    frames.push(
      'c',
      column.name,
      column.type,
      column.length === undefined ? '' : String(column.length),
      column.precision === undefined ? '' : String(column.precision),
      column.scale === undefined ? '' : String(column.scale),
      column.nullable ? '1' : '0',
      given === undefined ? '' : 'now' in given ? 'now' : 'v',
      given !== undefined && 'value' in given ? given.value : '',
    )
  }
  for (const index of definition.indexes)
    frames.push('i', index.name, index.unique ? '1' : '0', index.columns.join(','))
  return frames
}

/**
 * A table as the site's plugin reads it: whether it is there, whether the platform made it (its
 * mark), and its definition — null when it is not there or when the dictionary cannot say it
 * (another engine, a foreign key, a column of another type: a table any operation conflicts on).
 */
export const dbTableStateSchema = z
  .strictObject({
    version: z.literal(1),
    objectRef: dbTableRefSchema,
    exists: z.boolean(),
    managed: z.boolean(),
    definition: tableDefinitionSchema.nullable(),
    stateHash: contentHashSchema,
  })
  .refine((state) => state.exists || (!state.managed && state.definition === null))
export type DbTableState = z.infer<typeof dbTableStateSchema>
export const tableStateHashMaterial = (
  state: Pick<DbTableState, 'objectRef' | 'exists' | 'managed' | 'definition'>,
) =>
  dbHashFrames([
    'table',
    state.objectRef,
    state.exists ? '1' : '0',
    state.managed ? '1' : '0',
    ...(state.definition ? definitionFrames(state.definition) : []),
  ])

/** Any object a plan changes, in any state it can have. */
export const dbObjectStateSchema = z.union([
  publishedContentStateSchema,
  dbAbsentStateSchema,
  dbOptionStateSchema,
  dbTableStateSchema,
])
export type DbObjectState = z.infer<typeof dbObjectStateSchema>
export type DbRecordState = z.infer<typeof publishedContentStateSchema>

/** The material a state's hash is taken over, whatever the object. */
export function dbStateHashMaterial(state: DbObjectState): string {
  if ('absent' in state) return absentStateHashMaterial(state.objectRef)
  if ('kind' in state) return publishedContentHashMaterial(state)
  if ('exists' in state) return tableStateHashMaterial(state)
  return optionStateHashMaterial(state)
}

export const isAbsentState = (state: DbObjectState): state is DbAbsentState => 'absent' in state
export const isOptionState = (state: DbObjectState): state is DbOptionState =>
  isOptionRef(state.objectRef)
export const isTableState = (state: DbObjectState): state is DbTableState =>
  isTableRef(state.objectRef)
export const isRecordState = (state: DbObjectState): state is DbRecordState =>
  !isAbsentState(state) && isRecordRef(state.objectRef)

/**
 * Every text of a state a write puts on a site or a description shows: a record's title, text,
 * excerpt and address; a setting's value; a table's name, the names of its columns and indexes
 * and the defaults of its columns. One list for the description and for the release: a value of
 * a client's variable is sought in all of it (Р13).
 */
export function dbStateTexts(state: DbObjectState): string[] {
  if (isAbsentState(state)) return []
  if (isRecordState(state))
    return [state.title, state.content, state.excerpt, ...(state.slug ? [state.slug] : [])]
  if (isOptionState(state)) return state.value === null ? [] : [state.value]
  if (!isTableState(state)) return []
  const definition = state.definition
  return [
    tableNameOf(state.objectRef),
    ...(definition?.columns ?? []).flatMap((column) => [
      column.name,
      ...(column.default && 'value' in column.default ? [column.default.value] : []),
    ]),
    ...(definition?.indexes ?? []).map((index) => index.name),
  ]
}

// ---------------------------------------------------------------------------------------------
// What a schema migration may do
// ---------------------------------------------------------------------------------------------

const sameColumn = (a: DbColumn, b: DbColumn) =>
  JSON.stringify(definitionFrames({ columns: [a], indexes: [] })) ===
  JSON.stringify(definitionFrames({ columns: [b], indexes: [] }))
const sameIndex = (a: DbIndex, b: DbIndex) =>
  a.name === b.name && a.unique === b.unique && a.columns.join(',') === b.columns.join(',')

/**
 * How a definition comes from another by adding only (Р — «только аддитивные»): `create` — the
 * table was not there; `add` — the columns of `before` kept in their order with new ones after
 * them, each nullable or with a constant default, and the indexes of `before` kept with new ones
 * beside them, none unique (rows already there could break it); `same` — nothing. null — the
 * change removes, alters or renames something, or adds what an existing table cannot take.
 */
export function additiveChange(
  before: TableDefinition | null,
  after: TableDefinition,
): 'create' | 'add' | 'same' | null {
  if (before === null) return 'create'
  if (after.columns.length < before.columns.length) return null
  if (!before.columns.every((column, at) => sameColumn(column, after.columns[at]!))) return null
  const added = after.columns.slice(before.columns.length)
  if (
    added.some(
      (column) =>
        (column.default !== undefined && 'now' in column.default) ||
        (!column.nullable && column.default === undefined),
    )
  )
    return null
  const kept = new Map(before.indexes.map((index) => [index.name, index]))
  for (const index of before.indexes) {
    const now = after.indexes.find((candidate) => candidate.name === index.name)
    if (!now || !sameIndex(index, now)) return null
  }
  const newIndexes = after.indexes.filter((index) => !kept.has(index.name))
  if (newIndexes.some((index) => index.unique)) return null
  return added.length === 0 && newIndexes.length === 0 ? 'same' : 'add'
}

// ---------------------------------------------------------------------------------------------
// Settings and addresses
// ---------------------------------------------------------------------------------------------

/**
 * A setting of the site a plan may change (`SiteAdapter.dbSettings`): its name in the database,
 * the name the agent uses, the words the client reads, and its values. The list allows; a
 * setting not in it is never read or written.
 */
export const dbSettingSchema = z
  .strictObject({
    option: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    setting: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    label: z.string().min(1).max(80),
    value: z.enum(['text', 'integer']),
    maxBytes: z.number().int().min(1).max(4096).optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    /** Characters a text may not hold. */
    forbidden: z.string().max(16).optional(),
    /** How the client reads a value: as HTML text (entities decoded) or as it is. */
    display: z.enum(['html_text', 'plain']),
  })
  .refine(
    (setting) =>
      (setting.value === 'integer') === (setting.min !== undefined && setting.max !== undefined),
  )
export type DbSetting = z.infer<typeof dbSettingSchema>

/**
 * Whether a value fits a setting: a text within its bytes and without its forbidden characters,
 * an integer in its one decimal spelling and in its range. The site's plugin checks the same.
 */
export function dbSettingValueAllowed(setting: DbSetting, value: string): boolean {
  if (/\p{Cc}/u.test(value)) return false
  if (setting.value === 'integer') {
    if (!/^-?(0|[1-9]\d{0,9})$/.test(value) || value === '-0') return false
    const number = Number(value)
    return number >= setting.min! && number <= setting.max!
  }
  if (new TextEncoder().encode(value).byteLength > (setting.maxBytes ?? 4096)) return false
  return ![...(setting.forbidden ?? '')].some((char) => value.includes(char))
}

/**
 * The address of a created record within its site: lower-case Latin letters, digits and single
 * hyphens, not digits alone (those read as ids). The site's plugin says whether it is free.
 */
export const dbSlugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .refine((slug) => !/^\d+$/.test(slug))

/** The words of a type of a column for the client (the panel, the release window, tests). */
export function dbColumnTypeText(column: Pick<DbColumn, 'type' | 'length' | 'scale'>): string {
  switch (column.type) {
    case 'string': {
      const length = column.length ?? 0
      return `строка до ${length} ${pluralRu(length, 'знака', 'знаков', 'знаков')}`
    }
    case 'text':
    case 'long_text':
      return 'текст'
    case 'integer':
    case 'big_integer':
    case 'unsigned_big_integer':
      return 'число'
    case 'boolean':
      return 'да или нет'
    case 'decimal': {
      const scale = column.scale ?? 0
      return scale === 0
        ? 'число без дробной части'
        : `число с дробной частью (${scale} ${pluralRu(scale, 'знак', 'знака', 'знаков')} после запятой)`
    }
    case 'date':
      return 'дата'
    case 'datetime':
      return 'дата и время'
  }
}
