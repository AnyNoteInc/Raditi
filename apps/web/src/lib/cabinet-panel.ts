import { z } from 'zod'

/**
 * Whether the panel beside the rail is shown (docs/plan/64-cabinet-navigation.md, Н3): one state
 * for the whole cabinet — the chats, a project, the settings. Kept in a cookie so that the server
 * already paints the page with the panel or without it.
 */
export const CABINET_PANEL_COOKIE = 'raditi-panel'

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

export const cabinetPanelStates = ['open', 'closed'] as const
export type CabinetPanelState = (typeof cabinetPanelStates)[number]

const cabinetPanelStateSchema = z.enum(cabinetPanelStates).catch('open')

/** Unknown or missing cookie values fall back to `open`. */
export function parseCabinetPanelState(value: unknown): CabinetPanelState {
  return cabinetPanelStateSchema.parse(value)
}

/** The state in a `document.cookie` string. */
export function readCabinetPanelState(cookies: string): CabinetPanelState {
  const prefix = `${CABINET_PANEL_COOKIE}=`
  const pair = cookies
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
  return parseCabinetPanelState(pair?.slice(prefix.length))
}

export function serializeCabinetPanelCookie(
  state: CabinetPanelState,
  options: { secure: boolean },
): string {
  const attributes = [
    `${CABINET_PANEL_COOKIE}=${state}`,
    'Path=/',
    `Max-Age=${ONE_YEAR_SECONDS}`,
    'SameSite=Lax',
  ]
  if (options.secure) attributes.push('Secure')
  return attributes.join('; ')
}

/**
 * The width of the panel the viewer dragged its edge to (docs/plan/64-cabinet-navigation.md,
 * owner's answer of 07.11.2026), one for the whole cabinet, in whole pixels.
 */
export const CABINET_PANEL_WIDTH_COOKIE = 'raditi-panel-width'
export const CABINET_PANEL_DEFAULT_WIDTH = 284
export const CABINET_PANEL_MIN_WIDTH = 240
export const CABINET_PANEL_MAX_WIDTH = 440

export const clampCabinetPanelWidth = (width: number): number =>
  Math.round(Math.min(Math.max(width, CABINET_PANEL_MIN_WIDTH), CABINET_PANEL_MAX_WIDTH))

/** A width from the cookie; null for anything that is not a sane number of pixels. */
export function parseCabinetPanelWidth(value: string | undefined | null): number | null {
  if (value === undefined || value === null || !/^\d{3}$/.test(value)) return null
  const width = Number(value)
  return width >= CABINET_PANEL_MIN_WIDTH && width <= CABINET_PANEL_MAX_WIDTH ? width : null
}

export function serializeCabinetPanelWidthCookie(
  width: number,
  options: { secure: boolean },
): string {
  const attributes = [
    `${CABINET_PANEL_WIDTH_COOKIE}=${clampCabinetPanelWidth(width)}`,
    'Path=/',
    `Max-Age=${ONE_YEAR_SECONDS}`,
    'SameSite=Lax',
  ]
  if (options.secure) attributes.push('Secure')
  return attributes.join('; ')
}

/** The gap between the cards of the cabinet and around them, from `md` (Н1). */
export const CABINET_GAP = 10
/** The rail of the cabinet from `sm`. */
export const CABINET_RAIL_WIDTH = 72
