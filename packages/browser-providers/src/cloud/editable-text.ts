import { clipPageText } from '@repo/domain'
import type { Page } from 'playwright-core'

/**
 * The text of editable blocks in the agent's tree. Playwright's `ai` tree writes the value of an
 * `<input>` after its key, but not the text of an element that is a `textbox` by its role and
 * edits its own content (`contenteditable`) — the block editor's title is one: the agent would
 * never read back what it wrote there. Such a line, a textbox with neither a value nor children,
 * gets its element's text, read by Playwright in its isolated world. Before the secret fields
 * are hidden, so a field named as a secret is hidden whatever wrote its text.
 */

/** A textbox line with no value and no children: role, a quoted name maybe, attributes. */
const BARE_TEXTBOX = /^ *- textbox(?: "(?:[^"\\]|\\.)*")?((?: \[[^\]]*\])+)$/
const REF = / \[ref=((?:f[1-9]\d*)?e[1-9]\d*)\]/

/** Blocks read in one tree, and the characters of each: an editor has a few. */
const MAX_BLOCKS = 32
const MAX_CHARS = 2_000

export async function withEditableText(page: Page, tree: string, timeout: number): Promise<string> {
  const lines = tree.split('\n')
  let read = 0
  for (const [index, line] of lines.entries()) {
    if (read >= MAX_BLOCKS) break
    const attributes = BARE_TEXTBOX.exec(line)?.[1]
    const ref = attributes === undefined ? undefined : REF.exec(attributes)?.[1]
    if (ref === undefined) continue
    read++
    const text = await page
      .locator(`aria-ref=${ref}`)
      .innerText({ timeout })
      .catch(() => '')
    // An empty `<input>` reads as no text: its line stays as Playwright wrote it.
    const value = clipPageText(text.replace(/\s+/g, ' ').trim(), MAX_CHARS)
    if (value !== '') lines[index] = `${line}: ${JSON.stringify(value)}`
  }
  return lines.join('\n')
}
