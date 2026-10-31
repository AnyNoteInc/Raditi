import { BROWSER_HIDDEN_VALUE, browserTreeRefs, redactSecretValues } from '@repo/domain'
import type { Locator, Page } from 'playwright-core'

/** An input a person types into: a button or a hidden value of a form is no field of a card. */
const TYPED_INPUT = `input${[
  'hidden',
  'submit',
  'button',
  'reset',
  'image',
  'checkbox',
  'radio',
  'file',
]
  .map((type) => `:not([type="${type}" i])`)
  .join('')}`

/** What a person fills in: a form holds these whatever the page calls them. */
const CARD_FIELDS = [TYPED_INPUT, 'textarea', 'select']

/**
 * Fields of a payment card by `name` and `id`: the pages that give no `autocomplete`. Looked at
 * apart from `SECRET_INPUTS`, so a page full of such names never uses up the fields of a password.
 * `pan` only as a word: «company» and «japan» hold it too. A selector cannot say that of `card`,
 * which card forms glue to anything: this one finds more than it means, `isCardField` decides.
 */
export const CARD_INPUTS = ['name', 'id']
  .flatMap((attribute) =>
    [
      `[${attribute}*="card" i]`,
      `[${attribute}*="cvc" i]`,
      `[${attribute}*="cvv" i]`,
      `[${attribute}="pan" i]`,
      `[${attribute}^="pan_" i]`,
      `[${attribute}^="pan-" i]`,
      `[${attribute}$="_pan" i]`,
      `[${attribute}$="-pan" i]`,
      `[${attribute}$="[pan]" i]`,
    ].flatMap((matches) => CARD_FIELDS.map((field) => `${field}${matches}`)),
  )
  .join(', ')

/**
 * The name of a field of a card: `card` and `pan` as words, alone or with what card forms glue to
 * them (`card_number`, `cardNumber`, `creditcard`, `card[holder]`, `card1`, `pan_number`) — not
 * `wildcard`, `discard`, `postcard`, `cardio`, `japan`.
 */
const CARD_NAME =
  /(?<![a-z])(?:(?:credit|debit|payment|bank)?card(?:s|num|number|no|holder|name|code|exp|expiry|cvc|cvv|pan)?|pan)(?![a-z])|cvc|cvv/

/** `cardNumber` as `card_number`: a capital starts a word. */
const spacedWords = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

/**
 * Values of password, one-time-code and payment card fields never reach the agent
 * (docs/plan/57-browser-tasks.md, Б20; docs/plan/61-chats-first.md, К33): the tree of Playwright's
 * `ai` mode writes a field's value after its key, a password included. The fields are found by what
 * they are — their type, `autocomplete`, `name` and `id`, read by Playwright's own selector engine
 * in its isolated world, which no script of the page can change — and hidden three ways: by their
 * references in the tree, by the names the domain recognises (`redactSecretValues`), and by their
 * current values wherever they still stand in the text (a field the tree gives no reference, under
 * an overlay). A field found by its `name` or `id` alone is a guess: its value is hidden in the
 * field, not through the page, whose words it may be (a card's code, short as it is, stays as above).
 */
export const SECRET_INPUTS = [
  'input[type="password" i]',
  'input[autocomplete~="one-time-code" i]',
  'input[autocomplete*="password" i]',
  ...CARD_FIELDS.flatMap((field) => [
    `${field}[autocomplete~="cc-number" i]`,
    `${field}[autocomplete~="cc-csc" i]`,
    `${field}[autocomplete*="cc-exp" i]`,
  ]),
].join(', ')

/** Fields of one frame looked at; a page with more is a page of something else. */
const MAX_FIELDS = 16
/** Shorter values are not scrubbed from the text: they would hide the page's own words. */
const MIN_SCRUBBED_CHARS = 4
/**
 * A card's code and expiry are short, and the same elsewhere on the page they stand alone: scrubbed
 * at any length, never inside a longer word or number (`[ref=e123]` holds the reference).
 */
const SHORT_SECRET_FIELD = /cc-csc|cc-exp|cvc|cvv/i

export interface SecretFields {
  refs: Set<string>
  /** Values hidden wherever they stand in the text. */
  values: string[]
  /** Values of a card's code and expiry, hidden where they stand alone, at any length. */
  codes: string[]
  /** Fields whose own tree was read: each replaced the tree of its frame references resolve on. */
  read: number
}

/**
 * The references and values of the secret fields of every frame of a page. Each field's own
 * `ai` snapshot names its reference — the one the page's next tree gives it, as Playwright keeps
 * a reference on its element — so call this before the tree that is answered, never after: a
 * snapshot is also what Playwright resolves references against.
 */
export async function findSecretFields(page: Page, timeout: number): Promise<SecretFields> {
  const found: SecretFields = { refs: new Set(), values: [], codes: [], read: 0 }
  for (const frame of page.frames()) {
    await readFields(frame.locator(SECRET_INPUTS), found, timeout, true)
    await readFields(frame.locator(CARD_INPUTS), found, timeout, false)
  }
  return found
}

/** The fields a selector found; `certain` — found by what they are, not by what they are called. */
async function readFields(
  fields: Locator,
  found: SecretFields,
  timeout: number,
  certain: boolean,
): Promise<void> {
  const count = await fields.count().catch(() => 0)
  for (let index = 0; index < Math.min(count, MAX_FIELDS); index++) {
    const field = fields.nth(index)
    if (!certain && !(await isCardField(field, timeout))) continue
    found.read++
    const own = await field.ariaSnapshot({ mode: 'ai', timeout }).catch(() => '')
    for (const ref of browserTreeRefs(own)) found.refs.add(ref)
    const value = await field.inputValue({ timeout }).catch(() => '')
    if (value === '') continue
    if (await isShortSecret(field, timeout)) found.codes.push(value)
    else if (certain && value.length >= MIN_SCRUBBED_CHARS) found.values.push(value)
  }
}

/** Whether a field `CARD_INPUTS` found is one: its `name` or `id` holds a word of a card. */
async function isCardField(field: Locator, timeout: number): Promise<boolean> {
  for (const attribute of ['name', 'id']) {
    const value = await field.getAttribute(attribute, { timeout }).catch(() => null)
    if (value !== null && CARD_NAME.test(spacedWords(value))) return true
  }
  return false
}

/** Whether a field is a card's code or expiry, by the attributes that found it. */
async function isShortSecret(field: Locator, timeout: number): Promise<boolean> {
  for (const attribute of ['autocomplete', 'name', 'id']) {
    const value = await field.getAttribute(attribute, { timeout }).catch(() => null)
    if (value !== null && SHORT_SECRET_FIELD.test(value)) return true
  }
  return false
}

const escapeForPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** The tree with every secret field's value hidden, by reference, name and value. */
export function hideSecrets(tree: string, secrets: SecretFields): string {
  let hidden = redactSecretValues(tree, secrets.refs)
  for (const value of secrets.values) {
    // As written in the text, and as the tree quotes it (JSON escapes inside double quotes).
    const quoted = JSON.stringify(value).slice(1, -1)
    for (const form of new Set([value, quoted]))
      hidden = hidden.split(form).join(BROWSER_HIDDEN_VALUE)
  }
  for (const code of secrets.codes) {
    const alone = new RegExp(`(?<![\\p{L}\\p{N}])${escapeForPattern(code)}(?![\\p{L}\\p{N}])`, 'gu')
    hidden = hidden.replace(alone, BROWSER_HIDDEN_VALUE)
  }
  return hidden
}
