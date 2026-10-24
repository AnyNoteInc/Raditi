import {
  toViewportPoint,
  type BrowserPoint,
  type BrowserSize,
  type FittedRect,
} from '@repo/domain/browser/coordinates'
import {
  BROWSER_TEXT_INPUT_MAX_CHARS,
  browserNamedKeys,
  isBrowserKey,
  isBrowserTypedText,
  type BrowserInputEvent,
  type BrowserModifier,
  type BrowserMouseButton,
} from '@repo/domain/browser/stream-messages'

// What the client does on the picture of the page becomes input of the cloud browser
// (docs/plan/57-browser-tasks.md, §3.6, Б15): a point of the canvas is turned into a point of
// the browser's window — a point on a margin is not sent at all —, keys that print nothing and
// shortcuts go as keys, everything typed goes as text. Pure: the panel only wires events here.

/** A point of the panel in CSS pixels from its top-left corner. */
export function panelPoint(
  event: { clientX: number; clientY: number },
  bounds: { left: number; top: number },
): BrowserPoint {
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
}

/** The point of the window under an event; null on a margin or with nothing drawn. */
export function viewportPointOf(
  event: { clientX: number; clientY: number },
  bounds: { left: number; top: number },
  rect: FittedRect,
  viewport: BrowserSize,
): BrowserPoint | null {
  return toViewportPoint(panelPoint(event, bounds), rect, viewport)
}

/** `MouseEvent.button` as the browser names it; null for the back and forward buttons. */
export function mouseButtonOf(button: number): Exclude<BrowserMouseButton, 'none'> | null {
  if (button === 0) return 'left'
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return null
}

const LINE_PX = 16
const DELTA_LIMIT = 10_000

/** A wheel turn in CSS pixels of the window: lines and pages counted as the page would. */
export function wheelDelta(
  event: { deltaX: number; deltaY: number; deltaMode: number },
  page: BrowserSize,
  scale: number,
): { dx: number; dy: number } {
  const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? page.height : 1
  // A pixel of the panel is 1/scale pixels of the window.
  const factor = event.deltaMode === 0 && scale > 0 ? 1 / scale : unit
  const clamp = (value: number) =>
    Math.max(-DELTA_LIMIT, Math.min(DELTA_LIMIT, Math.round(Number.isFinite(value) ? value : 0)))
  return { dx: clamp(event.deltaX * factor), dy: clamp(event.deltaY * factor) }
}

export interface KeyLike {
  key: string
  code: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  /** `KeyboardEvent.keyCode`: 229 — the input method took the key (Safari's Enter that ends one). */
  keyCode?: number
  /** `getModifierState('AltGraph')`: the key prints a character of AltGr. */
  altGraph?: boolean
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Alt', 'Control', 'Meta', 'Shift', 'AltGraph'])
const NAMED: ReadonlySet<string> = new Set(browserNamedKeys)
/** A key of a Latin layout: the cloud browser knows it (Playwright throws on 'м' or '₽'). */
const ASCII_KEY = /^[\x20-\x7e]$/
/** `keyCode` of a key the input method handled: its text comes with the composition. */
const IME_KEY_CODE = 229

/** True on macOS and iOS, where ⌘ is the shortcut key. */
export const isApplePlatform = (
  nav:
    { platform?: string; userAgentData?: { platform?: string } } | undefined = globalThis.navigator,
): boolean => /Mac|iPhone|iPad|iPod/i.test(nav?.userAgentData?.platform ?? nav?.platform ?? '')

/** One printable character, not a named key. */
const isCharacter = (key: string) => [...key].length === 1

/**
 * The modifiers held with a key, in the order the stream lists them. On a Mac, ⌘ of a character
 * shortcut (⌘A, ⌘Z, ⌘B, ⌘S) goes as Ctrl: the cloud browser is Linux Chromium, where editing and
 * pages (Gutenberg's `primary`) take Ctrl and a Meta shortcut does nothing. ⌘ with a named key
 * (⌘←, ⌘Backspace) stays Meta: Ctrl+← does something else there.
 */
export function modifiersOf(event: KeyLike, apple = false): BrowserModifier[] {
  const command = apple && event.metaKey && !event.ctrlKey && isCharacter(event.key)
  const held: BrowserModifier[] = []
  if (event.altKey) held.push('Alt')
  if (event.ctrlKey || command) held.push('Control')
  if (event.metaKey && !command) held.push('Meta')
  if (event.shiftKey) held.push('Shift')
  return held
}

/**
 * The key a shortcut presses: on a non-Latin layout `key` is the layout's letter ('м' for
 * Ctrl+V), so the Latin letter or digit of the physical key comes from `code`; null when there is
 * none. A Latin layout keeps its own key (Dvorak's `code` names another letter).
 */
function shortcutKeyOf(event: KeyLike): string | null {
  if (ASCII_KEY.test(event.key)) return event.key
  const letter = /^Key([A-Z])$/.exec(event.code)
  if (letter) return letter[1]!.toLowerCase()
  const digit = /^Digit([0-9])$/.exec(event.code)
  return digit ? digit[1]! : null
}

/** A paste shortcut, on any layout: its text comes with the `paste` event, not as keys. */
export const isPasteShortcut = (event: KeyLike): boolean =>
  (event.ctrlKey || event.metaKey) && !event.altKey && shortcutKeyOf(event)?.toLowerCase() === 'v'

/**
 * The key event a keyboard event sends, or null when it sends none: typed characters go as text
 * (`input`, a finished composition, a paste), a modifier alone is held only with its key, and a
 * paste shortcut leaves its text to the `paste` event. Keys that print nothing — Enter,
 * Backspace, arrows… —, Space (it presses a focused checkbox or button) and shortcuts with Ctrl
 * or ⌘ (Ctrl+A, Ctrl+Z, Ctrl+S, on any layout) go as keys. `apple` — the client is on a Mac:
 * see `modifiersOf`.
 */
export function keyEventOf(
  event: KeyLike,
  type: 'down' | 'up',
  apple = false,
): BrowserInputEvent | null {
  if (
    event.isComposing ||
    event.keyCode === IME_KEY_CODE ||
    event.key === 'Process' ||
    event.key === 'Unidentified'
  )
    return null
  if (MODIFIER_KEYS.has(event.key) || isPasteShortcut(event)) return null
  const character = isCharacter(event.key)
  // AltGr prints a character (₽ is AltGr+8 on the Windows Russian layout), and Chrome on Windows
  // reports it as Ctrl+Alt: the character goes as text with the field's `input`, not as a key.
  if (character && (event.altGraph || (event.ctrlKey && event.altKey && !event.metaKey)))
    return null
  const shortcut = !NAMED.has(event.key) && (event.ctrlKey || event.metaKey) && character
  // Space presses a focused checkbox or button, as Enter does; in a text field the key types it.
  const space = event.key === ' '
  if (!NAMED.has(event.key) && !shortcut && !space) return null
  // A shortcut whose physical key has no Latin name is not sent: an unknown key would throw in
  // the cloud browser after its modifiers went down, and leave them held.
  const key = shortcut ? shortcutKeyOf(event) : event.key
  if (key === null || !isBrowserKey(key)) return null
  return {
    kind: 'key',
    type,
    key,
    code: /^[A-Za-z0-9]{0,32}$/.test(event.code) ? event.code : '',
    modifiers: modifiersOf(event, apple),
  }
}

/**
 * Typed or pasted text as `text` events: line breaks as `\n`, characters the stream refuses left
 * out, long text cut into parts the stream takes, never inside a pair of surrogates.
 */
export function textEventsOf(text: string): BrowserInputEvent[] {
  // Line breaks as `\n`; control characters but a tab and a line break, and halves of a
  // surrogate pair, are left out — the stream refuses them.
  const clean = [...text.replace(/\r\n?/g, '\n')]
    .filter((character) => isBrowserTypedText(character))
    .join('')
  const events: BrowserInputEvent[] = []
  let part = ''
  for (const character of clean) {
    if (part.length + character.length > BROWSER_TEXT_INPUT_MAX_CHARS) {
      events.push({ kind: 'text', text: part })
      part = ''
    }
    part += character
  }
  if (part !== '') events.push({ kind: 'text', text: part })
  return events
}

/** Clicks in a row: the same button, near the same point, in quick succession — up to three. */
export class ClickCounter {
  static readonly windowMs = 500
  static readonly distance = 5
  #last: { point: BrowserPoint; button: string; at: number; count: number } | null = null

  next(point: BrowserPoint, button: string, at: number): number {
    const last = this.#last
    const near =
      last !== null &&
      last.button === button &&
      at - last.at <= ClickCounter.windowMs &&
      Math.abs(point.x - last.point.x) <= ClickCounter.distance &&
      Math.abs(point.y - last.point.y) <= ClickCounter.distance
    const count = near ? Math.min(3, last.count + 1) : 1
    this.#last = { point, button, at, count }
    return count
  }
}
