import { CABINET_GAP, CABINET_RAIL_WIDTH } from '@/lib/cabinet-panel'

// The width of the panel of the tools beside an open chat (docs/plan/61-chats-first.md, §5.11):
// a card at the right edge from `lg`, the full height of the window, and the content leaves it
// this much room. The viewer may drag its edge: the width is a CSS variable the shell sets for both.

export const SITE_PANE_DEFAULT_WIDTH = 'clamp(440px, 46vw, 760px)'
export const SITE_PANE_WIDTH_VAR = '--site-pane-width'
/**
 * The mark the shell of the chats carries while the panel of a chat's tools is drawn: the panel
 * sets it and takes it away (`usePaneMark`), and the shell leaves the panel its room by it. Not
 * `:has([data-chat-pane])`: a browser left that true after the panel went, and the room with it
 * (owner's report of 14.11.2026, docs/plan/74).
 */
export const PANE_OPEN_MARK = 'data-chat-pane-open'
/** Under the shell of the chats while the panel is drawn: `${PANE_DRAWN}` as a selector of `&`. */
export const PANE_DRAWN = `[data-chat-shell][${PANE_OPEN_MARK}] &`

export const SITE_PANE_WIDTH = `var(${SITE_PANE_WIDTH_VAR}, ${SITE_PANE_DEFAULT_WIDTH})`

/** The narrowest panel, and the narrowest the chat beside it may become. */
export const SITE_PANE_MIN = 440
export const SITE_DIALOG_MIN = 360
/**
 * The rail, the three gaps around the cards (docs/plan/64-cabinet-navigation.md, Н1), the paddings
 * of the content (32 px each side from `md`) and the chat column.
 */
const PANE_RESERVED = CABINET_RAIL_WIDTH + 3 * CABINET_GAP + 2 * 32 + SITE_DIALOG_MIN

/** The cookie a viewer's width of the panel is kept in: the page is drawn with it at once. */
export const SITE_PANE_COOKIE = 'raditi-pane-width'

/** A width from the cookie, in whole pixels; null for anything that is not one. */
export function parsePaneWidth(value: string | undefined | null): number | null {
  if (value === undefined || value === null || !/^\d{3,4}$/.test(value)) return null
  const width = Number(value)
  return width >= SITE_PANE_MIN && width <= 4000 ? width : null
}

/** The panel's width for a window: never narrower than its minimum, nor the chat than its. */
export function clampPaneWidth(width: number, windowWidth: number): number {
  const max = Math.max(SITE_PANE_MIN, windowWidth - PANE_RESERVED)
  return Math.round(Math.min(Math.max(width, SITE_PANE_MIN), max))
}

/** The CSS of a chosen width: kept within the same bounds by the browser on any window. */
export const paneWidthCss = (width: number): string =>
  `clamp(${SITE_PANE_MIN}px, ${Math.round(width)}px, max(${SITE_PANE_MIN}px, calc(100vw - ${PANE_RESERVED}px)))`
