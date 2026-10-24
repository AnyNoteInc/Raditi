import { z } from 'zod'

import { clipPageText } from '../preview/ports.ts'
import {
  browserCheckpointKinds,
  browserCheckpointStates,
  browserObjectIdSchema,
} from './checkpoint.ts'
import {
  browserChooserSchema,
  browserControllers,
  browserDialogSchema,
  browserSessionLimits,
  browserTabSchema,
} from './session.ts'

/**
 * What the agent sees of a page (docs/plan/57-browser-tasks.md, Б20): text, never pixels — the
 * accessibility tree of Playwright in its `ai` mode, with a reference `[ref=e12]` on every element
 * it can act on (`f1e5` inside a frame, which includes the canvas of the block editor). An
 * observation has a number; an action names it with a reference of it, and a reference of an older
 * observation is refused (`BROWSER_STALE_OBSERVATION`).
 *
 * The tree of `ai` mode writes the value of a text field after its key, a password field
 * included: `- textbox "Пароль" [ref=e12]: hunter2`, or on a child line `- text: hunter2` when
 * the field has a placeholder. Values of password and one-time-code fields never leave the worker:
 * the adapter names the references of such fields it found, and a field whose name says what it
 * is is hidden even when it named none.
 */
export const browserObservationIdSchema = z.string().regex(/^o[1-9]\d{0,8}$/)
/** `e12` on the page, `f1e5` in a frame: references of Playwright's `ai` snapshot. */
export const browserRefSchema = z.string().regex(/^(?:f[1-9]\d{0,6})?e[1-9]\d{0,8}$/)

export const browserObservationLimits = Object.freeze({
  /** Characters of the tree an observation gives unless the agent asks for fewer or more. */
  defaultChars: 16_000,
  maxChars: 24_000,
  minChars: 1_000,
  /**
   * UTF-8 bytes of the tree whatever its script: with the page and its tabs the answer stays
   * within the 64 KiB of a tool's answer (`BROWSER_TOOL_RESPONSE_MAX_BYTES`).
   */
  treeBytes: 40 * 1024,
})

/** Bytes of a text in UTF-8, counted without encoding it. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      index++
    } else bytes += 3
  }
  return bytes
}

/** What stands for a hidden value in the tree. */
export const BROWSER_HIDDEN_VALUE = '[hidden]'

/** A dialog as the agent sees it: `web_dialog` answers the one that waits, no id needed. */
export const browserAgentDialogSchema = browserDialogSchema.omit({ id: true })
/** A file chooser as the agent sees it: `web_upload` fills the one that waits. */
export const browserAgentChooserSchema = browserChooserSchema.omit({ id: true })
/** The object the page edits, when it is one the task tracks. */
export const browserObservedCheckpointSchema = z.strictObject({
  kind: z.enum(browserCheckpointKinds),
  objectId: browserObjectIdSchema,
  state: z.enum(browserCheckpointStates),
})

/** An observation as the worker answers `web_observe` (before the role masks contacts in it). */
export const browserObservationSchema = z.strictObject({
  observation: browserObservationIdSchema,
  page: browserTabSchema,
  tabs: z.array(browserTabSchema).max(browserSessionLimits.tabs),
  controller: z.enum(browserControllers),
  tree: z
    .string()
    .max(browserObservationLimits.maxChars)
    .refine((tree) => utf8Length(tree) <= browserObservationLimits.treeBytes, 'tree too large'),
  /** The tree was cut at a line; observe a subtree (`ref`) to see the rest. */
  truncated: z.boolean(),
  /** A JavaScript dialog waits for `web_dialog`. */
  dialog: browserAgentDialogSchema.optional(),
  /** A file chooser waits for `web_upload`. */
  chooser: browserAgentChooserSchema.optional(),
  checkpoint: browserObservedCheckpointSchema.optional(),
})
export type BrowserObservation = z.infer<typeof browserObservationSchema>

// ---------------------------------------------------------------------------------------------
// Lines of the tree
// ---------------------------------------------------------------------------------------------

/** One line of the tree, `<indent>- <key>[: <value>|:]`, read as Playwright writes it. */
interface TreeLine {
  indent: number
  /** The key with YAML quoting undone: `textbox "Пароль" [ref=e12]`, `text`, `/placeholder`. */
  key: string
  /** The value after `: `, as written (YAML-quoted or plain); null — none. */
  value: string | null
  /** The line up to the value, kept when the value is replaced. */
  prefix: string
}

const ENTRY = /^( *)- (.*)$/

/** A key quoted by YAML (`'…'`, `''` for a quote) and what follows it; null if unterminated. */
function quotedKey(body: string): { key: string; rest: string } | null {
  let index = 1
  while (index < body.length) {
    if (body[index] === "'") {
      if (body[index + 1] !== "'") break
      index += 2
    } else {
      index++
    }
  }
  if (index >= body.length) return null
  return { key: body.slice(1, index).replaceAll("''", "'"), rest: body.slice(index + 1) }
}

function readLine(line: string): TreeLine | null {
  const match = ENTRY.exec(line)
  if (!match) return null
  const indent = (match[1] ?? '').length
  const body = match[2] ?? ''
  let key: string
  let rest: string
  if (body.startsWith("'")) {
    const quoted = quotedKey(body)
    if (quoted === null) return null
    ;({ key, rest } = quoted)
  } else {
    // A plain key never holds `: ` or ends with `:` — YAML would have quoted it.
    const colon = body.indexOf(': ')
    if (colon >= 0) [key, rest] = [body.slice(0, colon), body.slice(colon)]
    else if (body.endsWith(':')) [key, rest] = [body.slice(0, -1), ':']
    else [key, rest] = [body, '']
  }
  if (!rest.startsWith(': ')) return { indent, key, value: null, prefix: line }
  const value = rest.slice(2)
  return { indent, key, value, prefix: line.slice(0, line.length - value.length) }
}

/** The role, accessible name and reference of a key: `textbox "Пароль" [active] [ref=e12]`. */
function readKey(key: string): { role: string; name: string; ref: string | null; active: boolean } {
  const role = /^[a-z]+/.exec(key)?.[0] ?? ''
  const after = key.slice(role.length)
  // The name is JSON-quoted, or written as `/…/` up to the first attribute; the attributes
  // follow it, so a reference is read only after the name, never inside it.
  const quoted = /^ ("(?:[^"\\]|\\.)*")/.exec(after)
  const pattern = quoted ? null : /^ (\/[^[]*\/)(?= \[|$)/.exec(after)
  const written = quoted?.[1] ?? pattern?.[1] ?? ''
  let name = written
  if (quoted) {
    try {
      name = String(JSON.parse(written))
    } catch {
      name = written
    }
  }
  const attributes = after.slice(written === '' ? 0 : written.length + 1)
  const ref = /^(?: \[[^\]]*\])*? \[ref=((?:f\d+)?e\d+)\]/.exec(attributes)?.[1] ?? null
  const active = /^(?: \[[^\]]*\])*? \[active\]/.test(attributes)
  return { role, name, ref, active }
}

/**
 * Names of fields whose value is a secret: password, PIN, one-time or confirmation code, token,
 * secret, API key — as a word, not inside one («Шорткод», «Кодировка», «Postcode» are not).
 */
const SECRET_FIELD =
  /(?<![\p{L}\p{N}])(?:парол\p{L}*|pass(?:word|wd|phrase|code)s?|pin(?:[\s-]?(?:code|код))?|код\p{L}{0,2}|codes?|t?otp|2fa|токен\p{L}*|tokens?|секрет\p{L}*|secrets?|api[\s_-]?keys?|ключ\p{L}{0,2}\s+api)(?![\p{L}\p{N}])/iu

/** Whether the label or placeholder of a text field names a secret. */
export const isSecretFieldName = (name: string): boolean => SECRET_FIELD.test(name)

const isTextValue = (line: TreeLine) => line.key === 'text' && line.value !== null

/** The placeholder a field node's own child line states, if any. */
function placeholderOf(lines: readonly (TreeLine | null)[], at: number, indent: number): string {
  for (let index = at + 1; index < lines.length; index++) {
    const line = lines[index]
    if (line === null || line === undefined) continue
    if (line.indent <= indent) break
    if (line.key === '/placeholder' && line.value !== null) return line.value
  }
  return ''
}

/**
 * The tree with the values of secret fields replaced by `[hidden]`: of every element whose
 * reference is in `secretRefs` (the adapter's password and code fields), and of every `textbox`
 * whose name or placeholder names a secret. A value on the field's own line and on the `text`
 * lines below it are hidden; an empty one (`""`) is left, which tells only that the field is empty.
 */
export function redactSecretValues(tree: string, secretRefs: Iterable<string> = []): string {
  const refs = new Set(secretRefs)
  const raw = tree.split('\n')
  const lines = raw.map(readLine)
  const out = [...raw]
  const hide = (index: number) => {
    const line = lines[index]
    if (line?.value !== null && line?.value !== undefined && line.value !== '""')
      out[index] = `${line.prefix}${BROWSER_HIDDEN_VALUE}`
  }
  for (const [index, line] of lines.entries()) {
    if (line === null || line.key === 'text' || line.key.startsWith('/')) continue
    const { role, name, ref } = readKey(line.key)
    const secret =
      (ref !== null && refs.has(ref)) ||
      (role === 'textbox' &&
        (isSecretFieldName(name) || isSecretFieldName(placeholderOf(lines, index, line.indent))))
    if (!secret) continue
    hide(index)
    for (let below = index + 1; below < lines.length; below++) {
      const child = lines[below]
      if (child === null || child === undefined) continue
      if (child.indent <= line.indent) break
      if (isTextValue(child)) hide(below)
    }
  }
  return out.join('\n')
}

/**
 * The role and accessible name of the element a reference points to in a tree: what a commit
 * click is judged by (`SiteAdapter.browserCommitAction`). null — the tree has no such reference.
 */
export function browserTreeElement(
  tree: string,
  ref: string,
): { role: string; name: string } | null {
  for (const raw of tree.split('\n')) {
    const line = readLine(raw)
    if (line === null || !line.key.includes(`[ref=${ref}]`)) continue
    const key = readKey(line.key)
    if (key.ref === ref) return { role: key.role, name: key.name }
  }
  return null
}

/**
 * The role and accessible name of the element that has the focus in a tree (Playwright's
 * `[active]`): what a key pressed without a reference lands on, judged as a click on it
 * (`SiteAdapter.browserCommitAction`, Б22). A frame with the focus inside is marked as well as the
 * element in it that has it; the frame is never the one. null — the tree marks no other.
 */
export function browserTreeActiveElement(tree: string): { role: string; name: string } | null {
  let active: { role: string; name: string } | null = null
  for (const raw of tree.split('\n')) {
    const line = readLine(raw)
    if (line === null || !line.key.includes('[active]')) continue
    const key = readKey(line.key)
    if (key.active && key.role !== 'iframe') active = { role: key.role, name: key.name }
  }
  return active
}

/** Every reference a tree holds: the ones an action on this observation may name. */
export function browserTreeRefs(tree: string): Set<string> {
  const refs = new Set<string>()
  for (const raw of tree.split('\n')) {
    const line = readLine(raw)
    const ref = line === null ? null : readKey(line.key).ref
    if (ref !== null) refs.add(ref)
  }
  return refs
}

/**
 * The tree cut at a line end to at most `max` characters and `maxBytes` bytes of UTF-8. A first
 * line longer than that is cut where no part of a contact is left behind (`clipPageText`), so the
 * agent always sees something.
 */
export function clipTree(
  tree: string,
  max: number,
  maxBytes: number = browserObservationLimits.treeBytes,
): { text: string; truncated: boolean } {
  if (tree.length <= max && utf8Length(tree) <= maxBytes) return { text: tree, truncated: false }
  const lines = tree.split('\n')
  let chars = -1
  let bytes = -1
  let kept = 0
  for (const line of lines) {
    chars += line.length + 1
    bytes += utf8Length(line) + 1
    if (chars > max || bytes > maxBytes) break
    kept++
  }
  if (kept > 0) return { text: lines.slice(0, kept).join('\n'), truncated: true }
  // A UTF-16 unit is at most three bytes of UTF-8 (a surrogate pair is four for two).
  const first = clipPageText(lines[0] ?? '', Math.min(max, Math.floor(maxBytes / 3)))
  return { text: first, truncated: true }
}
