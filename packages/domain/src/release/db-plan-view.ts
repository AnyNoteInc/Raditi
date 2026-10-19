import { z } from 'zod'

import { clipPageText } from '../preview/ports.ts'
import {
  additiveChange,
  dbColumnSchema,
  dbIndexSchema,
  dbStateTexts,
  isAbsentState,
  isOptionState,
  isRecordState,
  isTableState,
  optionNameOf,
  recordTypeOf,
  tableNameOf,
  type DbObjectState,
  type DbSetting,
} from './db-objects.ts'
import { dbContentFields, type DbOperation } from './db-plan.ts'

// What the client reads of a database plan before `/release` (docs/plan/53-chat-preview-release.
// md, «Операции БД и миграции»): every operation with its values, new and old, in a bounded form.
// The trusted side builds it from the states it sealed — the agent's preview never — and keeps it
// with the revision of the candidate (`task_candidates.db_view`); the release confirms the
// revision it belongs to. No operation is ever left out: what does not fit is shortened, and
// every shortening is said on its card. A plan whose cards do not fit even then is `oversize`:
// nothing of it is shown, and nothing of it is released.

/** The most bytes of a description: what `task_candidates_db_view_check` allows. */
export const DB_PLAN_VIEW_MAX_BYTES = 512 * 1024
/** Above this many added or removed links of a text the operation is refused, never cut. */
export const DB_PLAN_VIEW_LINKS = 500
/** Above this many words a side the difference is not computed: the text is said replaced. */
const DIFF_WORDS = 20_000
/** The longest edit script looked for; a text changed more is said replaced. */
const DIFF_STEPS = 1_000
/** Words of context around a change. */
const CONTEXT_WORDS = 12

const text = z.string().max(DB_PLAN_VIEW_MAX_BYTES)
const pair = z.strictObject({ before: text, after: text, truncated: z.boolean() })
const hunk = z.strictObject({ op: z.enum(['same', 'add', 'del', 'gap']), text })
const base = { index: z.number().int().min(0).max(1000), objectRef: z.string().max(128) }
/** The addresses a change adds and removes (`markupLinks`), each as written. */
const links = z.strictObject({ added: z.array(text), removed: z.array(text) })
/** A title or an excerpt: its words before and after, and what its markup adds. */
const field = z.strictObject({
  before: text,
  after: text,
  /** The words are the same, the markup is not. */
  markupOnly: z.boolean(),
  links,
  truncated: z.boolean(),
})

export const dbOperationViewSchema = z.union([
  z.strictObject({
    kind: z.literal('content_update'),
    ...base,
    record: z.strictObject({ type: z.string().max(32), title: text }),
    fields: z.array(z.enum(dbContentFields)).min(1).max(3),
    title: field.optional(),
    excerpt: field.optional(),
    content: z
      .strictObject({
        /** The text without markup, by words; null — replaced as a whole (`replaced`). */
        hunks: z.array(hunk).nullable(),
        replaced: pair.nullable(),
        /** The words are the same, the markup is not. */
        markupOnly: z.boolean(),
        links,
        truncated: z.boolean(),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('option_update'),
    ...base,
    label: z.string().max(80),
    before: text.nullable(),
    after: text,
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('post_create'),
    ...base,
    record: z.strictObject({ type: z.string().max(32) }),
    title: text,
    slug: z.string().max(200),
    status: z.enum(['publish', 'draft']),
    excerpt: text,
    /** The beginning of the text without markup. */
    contentText: text,
    contentBytes: z.number().int().min(0),
    /** Every address the title, the excerpt and the text link or load. */
    links: z.array(text),
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('schema_migration'),
    ...base,
    table: z.string().max(64),
    created: z.boolean(),
    /** What the release adds: every column of a new table, the new ones of an existing one. */
    columns: z.array(dbColumnSchema),
    indexes: z.array(dbIndexSchema),
  }),
  z.strictObject({
    kind: z.enum(['content_update', 'option_update', 'post_create', 'schema_migration']),
    ...base,
    /**
     * Not shown, and not released: a value holds one of the client's variables, a text adds or
     * removes more links than a card says, or a table change is not an addition.
     */
    refused: z.enum(['client_variable', 'too_many_links', 'not_additive']),
  }),
])
export type DbOperationView = z.infer<typeof dbOperationViewSchema>
type ContentView = Extract<DbOperationView, { kind: 'content_update'; fields: unknown }>

/** Whether anything of a card is shortened. */
export function dbOperationViewTruncated(view: DbOperationView): boolean {
  if ('refused' in view) return false
  if (view.kind === 'content_update')
    return Boolean(view.title?.truncated || view.excerpt?.truncated || view.content?.truncated)
  return 'truncated' in view && view.truncated
}

export const dbPlanViewSchema = z.strictObject({
  v: z.literal(1),
  /** `task_candidates.db_plan_sha256` of the plan described. */
  planSha256: z.string().regex(/^[0-9a-f]{64}$/),
  operations: z.array(dbOperationViewSchema).max(200),
  /** Something of a card is shortened: the release window asks to look at the preview. */
  truncated: z.boolean(),
  /** The cards do not fit even shortened: nothing is shown, the plan is not released. */
  oversize: z.boolean(),
})
export type DbPlanView = z.infer<typeof dbPlanViewSchema>

// ---------------------------------------------------------------------------------------------
// Text without markup, links, differences
// ---------------------------------------------------------------------------------------------

const namedReferences: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
}
/** Character references of HTML read as the characters they stand for. */
export function decodeHtmlReferences(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (written, name: string) => {
    if (name[0] !== '#') return namedReferences[name.toLowerCase()] ?? written
    const code =
      name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code)
      : written
  })
}

/** What a reader sees of HTML: comments and tags dropped, references read, spaces folded. */
export function markupText(html: string): string {
  return decodeHtmlReferences(
    html
      .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
      .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
      .replace(/<\/?[a-z][^>]*>/gi, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/** The value of each attribute named `names` in a fragment, references read. */
function attributeValues(html: string, names: string): string[] {
  const pattern = new RegExp(
    `(?<![\\w-])(?:${names})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'gi',
  )
  const values: string[] = []
  for (let match = pattern.exec(html); match; match = pattern.exec(html))
    values.push(decodeHtmlReferences(match[1] ?? match[2] ?? match[3] ?? ''))
  return values
}

/** Attributes whose value is an address a browser follows or loads. */
const LINK_ATTRIBUTES = 'href|src|cite|poster|longdesc|usemap|data|background|action|formaction'
/** A value that reads as an address: a scheme or `//` at its start. */
const ADDRESS_START = /^\s*(?:(?:[a-z][a-z0-9+.-]*:)?\/\/|(?:javascript|data|mailto|tel):)/i

/** The addresses of a style sheet or a `style` attribute: each `url()` and `@import`. */
function cssLinks(css: string): string[] {
  const links: string[] = []
  const pattern =
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi
  for (let match = pattern.exec(css); match; match = pattern.exec(css))
    links.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '')
  return links
}

/**
 * Every address a fragment links or loads, as written, references read: the attributes that hold
 * one (`href`, `src`, `cite`, `poster` and the like), each candidate of a `srcset`, a `data-*`
 * value that reads as an address (a script of the site may load it), each `url()` of a style,
 * and every address inside a comment — a stack may keep a block of its editor there, an embed
 * with its address among them (JSON escapes read). Nothing of a stack is known here: whatever
 * looks like an address is listed.
 */
export function markupLinks(html: string): string[] {
  const found = new Set<string>()
  const add = (value: string) => {
    const link = value.trim()
    if (link) found.add(link)
  }
  attributeValues(html, LINK_ATTRIBUTES).forEach(add)
  for (const set of attributeValues(html, 'srcset'))
    for (const candidate of set.split(',')) add(candidate.trim().split(/\s+/)[0] ?? '')
  for (const value of attributeValues(html, 'data-[a-z0-9_.:-]+'))
    if (ADDRESS_START.test(value)) add(value)
  for (const style of attributeValues(html, 'style')) cssLinks(style).forEach(add)
  const sheets = /<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi
  for (let sheet = sheets.exec(html); sheet; sheet = sheets.exec(html))
    cssLinks(sheet[1]!).forEach(add)
  const comments = /<!--([\s\S]*?)(?:-->|$)/g
  for (let comment = comments.exec(html); comment; comment = comments.exec(html)) {
    const body = comment[1]!
      .replace(/\\u([0-9a-f]{4})/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\\//g, '/')
    const address = /(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s"'<>\\]+/gi
    for (let match = address.exec(body); match; match = address.exec(body)) add(match[0])
  }
  return [...found]
}

type LinkDiff = { added: string[]; removed: string[] }

/**
 * The addresses a text adds and removes; null — more of either than a card says
 * (DB_PLAN_VIEW_LINKS): such a change is refused, never cut.
 */
function linkDiff(before: string, after: string): LinkDiff | null {
  const was = markupLinks(before)
  const now = markupLinks(after)
  const added = now.filter((link) => !was.includes(link))
  const removed = was.filter((link) => !now.includes(link))
  return added.length > DB_PLAN_VIEW_LINKS || removed.length > DB_PLAN_VIEW_LINKS
    ? null
    : { added, removed }
}

/** Each address of a difference cut to `limit`, and whether any was. */
function clipLinks(diff: LinkDiff, limit: number): LinkDiff & { truncated: boolean } {
  let truncated = false
  const cut = (value: string) => {
    const shown = clipped(value, limit)
    truncated ||= shown.truncated
    return shown.value
  }
  return { added: diff.added.map(cut), removed: diff.removed.map(cut), truncated }
}

type Op = 'same' | 'add' | 'del'
const tokens = (value: string) => value.match(/\s+|\S+/g) ?? []
const words = (list: readonly string[]) => list.filter((token) => /\S/.test(token)).length

/**
 * The shortest edit script of two lists of tokens (Myers, 1986), or null when it is longer than
 * `maxSteps`: such a text is said replaced rather than shown changed everywhere.
 */
export function diffTokens(
  a: readonly string[],
  b: readonly string[],
  maxSteps: number = DIFF_STEPS,
): { op: Op; token: string }[] | null {
  // What both share at the start and the end is left out of the search.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++
  const x0 = a.slice(start, a.length - end)
  const y0 = b.slice(start, b.length - end)
  const n = x0.length
  const m = y0.length
  const middle: { op: Op; token: string }[] = []
  if (n > 0 || m > 0) {
    const max = n + m
    const offset = max + 1
    const v = new Int32Array(2 * max + 3)
    const trace: Int32Array[] = []
    let found = -1
    for (let d = 0; d <= Math.min(max, maxSteps) && found < 0; d++) {
      trace.push(v.slice(offset - d - 1, offset + d + 2))
      for (let k = -d; k <= d; k += 2) {
        let x =
          k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
            ? v[offset + k + 1]!
            : v[offset + k - 1]! + 1
        let y = x - k
        while (x < n && y < m && x0[x] === y0[y]) {
          x++
          y++
        }
        v[offset + k] = x
        if (x >= n && y >= m) {
          found = d
          break
        }
      }
    }
    if (found < 0) return null
    let x = n
    let y = m
    for (let d = found; d >= 0; d--) {
      const saved = trace[d]!
      const at = (k: number) => saved[k + d + 1]!
      const k = x - y
      const previous = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
      const px = d === 0 ? 0 : at(previous)
      const py = px - previous
      while (x > px && y > py) {
        middle.push({ op: 'same', token: x0[--x]! })
        y--
      }
      if (d > 0) {
        if (x === px) middle.push({ op: 'add', token: y0[y - 1]! })
        else middle.push({ op: 'del', token: x0[x - 1]! })
      }
      x = px
      y = py
    }
    middle.reverse()
  }
  return [
    ...a.slice(0, start).map((token) => ({ op: 'same' as const, token })),
    ...middle,
    ...a.slice(a.length - end).map((token) => ({ op: 'same' as const, token })),
  ]
}

interface Budget {
  /** Bytes of the hunks of one text. */
  body: number
  excerpt: number
  title: number
  link: number
}
/** Levels a description is built at, from the fullest: the first that fits is kept. */
const budgets: readonly Budget[] = [
  { body: 6144, excerpt: 1000, title: 300, link: 300 },
  { body: 2048, excerpt: 400, title: 200, link: 200 },
  { body: 512, excerpt: 160, title: 120, link: 120 },
  { body: 0, excerpt: 0, title: 80, link: 100 },
]

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength
const clipped = (value: string, limit: number) => {
  const cut = clipPageText(value, limit)
  return { value: cut, truncated: cut !== value }
}

type Runs = { op: Op; tokens: string[] }[]

/** The runs of the difference of two texts by words; null — too long or too different to compare. */
function textRuns(before: string, after: string): Runs | null {
  const a = tokens(before)
  const b = tokens(after)
  if (words(a) > DIFF_WORDS || words(b) > DIFF_WORDS) return null
  const script = diffTokens(a, b)
  if (!script) return null
  const runs: Runs = []
  for (const step of script) {
    const last = runs.at(-1)
    if (last?.op === step.op) last.tokens.push(step.token)
    else runs.push({ op: step.op, tokens: [step.token] })
  }
  return runs
}

/**
 * The hunks of a difference within `bodyBytes`: what is the same around a change keeps
 * CONTEXT_WORDS words each side, the rest is a gap; past the bytes the rest is cut, and said so.
 */
function hunksOf(
  runs: Runs,
  bodyBytes: number,
): { hunks: { op: 'same' | 'add' | 'del' | 'gap'; text: string }[]; truncated: boolean } {
  const context = CONTEXT_WORDS * 2
  const hunks: { op: 'same' | 'add' | 'del' | 'gap'; text: string }[] = []
  let bytes = 0
  let truncated = false
  const push = (op: 'same' | 'add' | 'del' | 'gap', value: string) => {
    if (truncated) return
    const size = byteLength(value)
    if (bytes + size > bodyBytes) {
      truncated = true
      return
    }
    bytes += size
    hunks.push({ op, text: value })
  }
  runs.forEach((run, at) => {
    if (run.op !== 'same') return push(run.op, run.tokens.join(''))
    const first = at === 0
    const last = at === runs.length - 1
    const keep = run.tokens
    if (first && last) return
    if (first) {
      if (keep.length > context) push('gap', '')
      return push('same', keep.slice(-context).join(''))
    }
    if (last) {
      push('same', keep.slice(0, context).join(''))
      if (keep.length > context) push('gap', '')
      return
    }
    if (keep.length <= context * 2) return push('same', keep.join(''))
    push('same', keep.slice(0, context).join(''))
    push('gap', '')
    push('same', keep.slice(-context).join(''))
  })
  return { hunks, truncated }
}

// ---------------------------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------------------------

export interface DbPlanViewInput {
  planSha256: string
  /** Each operation of the plan with the states its sides hold, as the trusted side opened them. */
  operations: readonly { operation: DbOperation; before: DbObjectState; after: DbObjectState }[]
  /** The settings of the stack (`SiteAdapter.dbSettings`): their words and how they are read. */
  settings: readonly DbSetting[]
  /** Whether a value holds one of the client's variables (Р13): such a card holds no value. */
  holdsVariable: (value: string) => boolean
}

const notTheState = () => new Error('A side of a database operation holds another state')

interface Compared {
  runs: Map<number, Runs | null>
  links: Map<string, unknown>
}

function card(
  index: number,
  entry: DbPlanViewInput['operations'][number],
  input: DbPlanViewInput,
  budget: Budget,
  /**
   * The runs and the addresses of each text compared already: a level of detail does not
   * compare again.
   */
  compared: Compared,
): DbOperationView {
  const { operation, before, after } = entry
  const head = { index, objectRef: operation.objectRef }
  const links = <T>(field: string, work: () => T): T => {
    const key = `${index}:${field}`
    if (!compared.links.has(key)) compared.links.set(key, work())
    return compared.links.get(key) as T
  }
  // Every text either side holds, a new page's address and a table's names included: what a
  // release writes is what the card shows, and neither may hold a variable. A table is named
  // by its reference, so such a card keeps no name of it.
  if ([...dbStateTexts(before), ...dbStateTexts(after)].some(input.holdsVariable))
    return {
      kind: operation.kind,
      index,
      objectRef: isTableState(after) ? 'table:' : operation.objectRef,
      refused: 'client_variable',
    }
  switch (operation.kind) {
    case 'content_update': {
      if (!isRecordState(before) || !isRecordState(after)) throw notTheState()
      const view: ContentView = {
        kind: 'content_update',
        ...head,
        record: {
          type: recordTypeOf(operation.objectRef),
          title: clipped(markupText(after.title), budget.title).value,
        },
        fields: [...operation.fields],
      }
      for (const field of ['title', 'excerpt'] as const) {
        if (!operation.fields.includes(field)) continue
        const limit = field === 'title' ? budget.title : budget.excerpt
        const diff = links(field, () => linkDiff(before[field], after[field]))
        if (diff === null) return { kind: operation.kind, ...head, refused: 'too_many_links' }
        const change = clipLinks(diff, budget.link)
        const words = [markupText(before[field]), markupText(after[field])] as const
        const was = clipped(words[0], limit)
        const now = clipped(words[1], limit)
        view[field] = {
          before: was.value,
          after: now.value,
          markupOnly: words[0] === words[1],
          links: { added: change.added, removed: change.removed },
          truncated: was.truncated || now.truncated || change.truncated,
        }
      }
      if (operation.fields.includes('content')) {
        const diff = links('content', () => linkDiff(before.content, after.content))
        if (diff === null) return { kind: operation.kind, ...head, refused: 'too_many_links' }
        const change = clipLinks(diff, budget.link)
        const texts = [markupText(before.content), markupText(after.content)] as const
        if (!compared.runs.has(index)) compared.runs.set(index, textRuns(texts[0], texts[1]))
        const runs = compared.runs.get(index) ?? null
        const hunks = runs ? hunksOf(runs, budget.body) : null
        const replaced = hunks
          ? null
          : (() => {
              const was = clipped(texts[0], budget.excerpt)
              const now = clipped(texts[1], budget.excerpt)
              return {
                before: was.value,
                after: now.value,
                truncated: was.truncated || now.truncated,
              }
            })()
        view.content = {
          hunks: hunks?.hunks ?? null,
          replaced,
          markupOnly: texts[0] === texts[1],
          links: { added: change.added, removed: change.removed },
          truncated: change.truncated || (hunks?.truncated ?? replaced!.truncated),
        }
      }
      return view
    }
    case 'option_update': {
      if (!isOptionState(before) || !isOptionState(after) || after.value === null)
        throw notTheState()
      const setting = input.settings.find(
        (candidate) => candidate.option === optionNameOf(operation.objectRef),
      )
      const read = (value: string) =>
        setting?.display === 'html_text' ? decodeHtmlReferences(value) : value
      const was = before.value === null ? null : clipped(read(before.value), budget.title)
      const now = clipped(read(after.value), budget.title)
      return {
        kind: 'option_update',
        ...head,
        label: setting?.label ?? optionNameOf(operation.objectRef),
        before: was?.value ?? null,
        after: now.value,
        truncated: (was?.truncated ?? false) || now.truncated,
      }
    }
    case 'post_create': {
      if (!isAbsentState(before) || !isRecordState(after)) throw notTheState()
      const found = links('created', () => [
        ...new Set([after.title, after.excerpt, after.content].flatMap(markupLinks)),
      ])
      if (found.length > DB_PLAN_VIEW_LINKS)
        return { kind: operation.kind, ...head, refused: 'too_many_links' }
      const title = clipped(markupText(after.title), budget.title)
      const excerpt = clipped(markupText(after.excerpt), budget.excerpt)
      const content = clipped(markupText(after.content), Math.max(budget.excerpt, budget.body / 2))
      const cut = found.map((link) => clipped(link, budget.link))
      return {
        kind: 'post_create',
        ...head,
        record: { type: recordTypeOf(operation.objectRef) },
        title: title.value,
        slug: after.slug ?? '',
        status: after.status ?? 'publish',
        excerpt: excerpt.value,
        contentText: content.value,
        contentBytes: byteLength(after.content),
        links: cut.map((link) => link.value),
        truncated:
          title.truncated ||
          excerpt.truncated ||
          content.truncated ||
          cut.some((link) => link.truncated),
      }
    }
    case 'schema_migration': {
      if (!isTableState(before) || !isTableState(after) || !after.definition) throw notTheState()
      const start = before.exists ? before.definition : null
      const change =
        before.exists && (!before.managed || !before.definition)
          ? null
          : additiveChange(start, after.definition)
      if (change === null || change === 'same')
        return { kind: operation.kind, ...head, refused: 'not_additive' }
      const known = new Set(start?.columns.map((column) => column.name) ?? [])
      const indexed = new Set(start?.indexes.map((index) => index.name) ?? [])
      return {
        kind: 'schema_migration',
        ...head,
        table: tableNameOf(operation.objectRef),
        created: change === 'create',
        columns: after.definition.columns.filter((column) => !known.has(column.name)),
        indexes: after.definition.indexes.filter((index) => !indexed.has(index.name)),
      }
    }
  }
}

/**
 * The description of a plan: one card per operation, in the order of the plan, at the fullest
 * level of detail that fits DB_PLAN_VIEW_MAX_BYTES. Throws when a side holds another kind of
 * state than its operation — the trusted side sealed it, so that is broken data.
 */
export function buildDbPlanView(input: DbPlanViewInput): DbPlanView {
  const compared: Compared = { runs: new Map(), links: new Map() }
  for (const budget of budgets) {
    const operations = input.operations.map((entry, index) =>
      card(index, entry, input, budget, compared),
    )
    const view: DbPlanView = {
      v: 1,
      planSha256: input.planSha256,
      operations,
      truncated: operations.some(dbOperationViewTruncated),
      oversize: false,
    }
    if (byteLength(JSON.stringify(view)) <= DB_PLAN_VIEW_MAX_BYTES) return view
  }
  return { v: 1, planSha256: input.planSha256, operations: [], truncated: true, oversize: true }
}

/**
 * Above this many objects a plan is a bulk edit (CLAUDE.md, rule 4): the release window shows
 * every change and asks the client to say they looked at them all — in a dialog that is the
 * `request_approval` with its list.
 */
export const DB_PLAN_BULK_OBJECTS = 20

/**
 * Whether `/release` asks the client to say they looked at every change: a bulk plan, or a
 * description with anything shortened (the preview shows the rest).
 */
export const dbPlanViewNeedsReview = (view: DbPlanView): boolean =>
  view.operations.length > DB_PLAN_BULK_OBJECTS || view.truncated

/**
 * Why a plan of `operations` operations with this hash is not released with the description
 * `stored` — the one rule of the release window and of the readiness of core: a description that
 * is missing, does not read, is of another plan or did not fit (`values_unavailable`), or one with
 * a card it refused — a value of a client's variable (`client_variable`), more links than a card
 * says or a table change that is not an addition (`values_unavailable`). null — it is released;
 * an empty plan needs no description.
 */
export function dbPlanViewRefusal(
  stored: unknown,
  plan: { sha256: string | null; operations: number },
): 'values_unavailable' | 'client_variable' | null {
  if (plan.operations === 0) return null
  const view = dbPlanViewSchema.safeParse(stored)
  if (
    !view.success ||
    view.data.oversize ||
    view.data.planSha256 !== plan.sha256 ||
    view.data.operations.length !== plan.operations
  )
    return 'values_unavailable'
  for (const card of view.data.operations)
    if ('refused' in card)
      return card.refused === 'client_variable' ? 'client_variable' : 'values_unavailable'
  return null
}

/** Every text of a description: what a value the client declares a variable later is sought in. */
export function dbPlanViewTexts(view: unknown): string[] {
  const texts: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') texts.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(view)
  return texts
}
