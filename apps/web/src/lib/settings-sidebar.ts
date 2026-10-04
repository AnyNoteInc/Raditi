import { z } from 'zod'

/**
 * Whether the settings sidebar is collapsed to a rail. Kept in a cookie, like the colour mode,
 * so that the server already paints the chosen width.
 */
export const SETTINGS_SIDEBAR_COOKIE = 'settings-sidebar'

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

export const settingsSidebarStates = ['expanded', 'collapsed'] as const
export type SettingsSidebarState = (typeof settingsSidebarStates)[number]

const settingsSidebarStateSchema = z.enum(settingsSidebarStates).catch('expanded')

/** Unknown or missing cookie values fall back to `expanded`. */
export function parseSettingsSidebarState(value: unknown): SettingsSidebarState {
  return settingsSidebarStateSchema.parse(value)
}

/** The state in a `document.cookie` string. */
export function readSettingsSidebarState(cookies: string): SettingsSidebarState {
  const prefix = `${SETTINGS_SIDEBAR_COOKIE}=`
  const pair = cookies
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
  return parseSettingsSidebarState(pair?.slice(prefix.length))
}

export function serializeSettingsSidebarCookie(
  state: SettingsSidebarState,
  options: { secure: boolean },
): string {
  const attributes = [
    `${SETTINGS_SIDEBAR_COOKIE}=${state}`,
    'Path=/',
    `Max-Age=${ONE_YEAR_SECONDS}`,
    'SameSite=Lax',
  ]
  if (options.secure) attributes.push('Secure')
  return attributes.join('; ')
}
