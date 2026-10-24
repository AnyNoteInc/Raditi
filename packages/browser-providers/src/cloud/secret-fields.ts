import { BROWSER_HIDDEN_VALUE, browserTreeRefs, redactSecretValues } from '@repo/domain'
import type { Page } from 'playwright-core'

/**
 * Values of password and one-time-code fields never reach the agent (docs/plan/57-browser-tasks.md,
 * Б20): the tree of Playwright's `ai` mode writes a field's value after its key, a password
 * included. The fields are found by what they are — their type and `autocomplete`, read by
 * Playwright's own selector engine in its isolated world, which no script of the page can change
 * — and hidden three ways: by their references in the tree, by the names the domain recognises
 * (`redactSecretValues`), and by their current values wherever they still stand in the text (a
 * field the tree gives no reference, under an overlay).
 */
export const SECRET_INPUTS =
  'input[type="password" i], input[autocomplete~="one-time-code" i], input[autocomplete*="password" i]'

/** Fields of one frame looked at; a page with more is a page of something else. */
const MAX_FIELDS = 16
/** Shorter values are not scrubbed from the text: they would hide the page's own words. */
const MIN_SCRUBBED_CHARS = 4

export interface SecretFields {
  refs: Set<string>
  values: string[]
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
  const found: SecretFields = { refs: new Set(), values: [], read: 0 }
  for (const frame of page.frames()) {
    const fields = frame.locator(SECRET_INPUTS)
    const count = await fields.count().catch(() => 0)
    for (let index = 0; index < Math.min(count, MAX_FIELDS); index++) {
      const field = fields.nth(index)
      found.read++
      const own = await field.ariaSnapshot({ mode: 'ai', timeout }).catch(() => '')
      for (const ref of browserTreeRefs(own)) found.refs.add(ref)
      const value = await field.inputValue({ timeout }).catch(() => '')
      if (value.length >= MIN_SCRUBBED_CHARS) found.values.push(value)
    }
  }
  return found
}

/** The tree with every secret field's value hidden, by reference, name and value. */
export function hideSecrets(tree: string, secrets: SecretFields): string {
  let hidden = redactSecretValues(tree, secrets.refs)
  for (const value of secrets.values) {
    // As written in the text, and as the tree quotes it (JSON escapes inside double quotes).
    const quoted = JSON.stringify(value).slice(1, -1)
    for (const form of new Set([value, quoted]))
      hidden = hidden.split(form).join(BROWSER_HIDDEN_VALUE)
  }
  return hidden
}
