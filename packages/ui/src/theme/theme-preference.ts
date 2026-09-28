import { z } from 'zod'

/** The only source of the colour mode: apps read it on the server and pass it to UiProvider. */
export const THEME_COOKIE = 'theme'

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

export const themePreferences = ['light', 'dark', 'system'] as const
export type ThemePreference = (typeof themePreferences)[number]

const themePreferenceSchema = z.enum(themePreferences).catch('system')

/** Unknown or missing cookie values fall back to `system`. */
export function parseThemePreference(value: unknown): ThemePreference {
  return themePreferenceSchema.parse(value)
}

export function serializeThemeCookie(
  preference: ThemePreference,
  options: { secure: boolean },
): string {
  const attributes = [
    `${THEME_COOKIE}=${preference}`,
    'Path=/',
    `Max-Age=${ONE_YEAR_SECONDS}`,
    'SameSite=Lax',
  ]
  if (options.secure) attributes.push('Secure')
  return attributes.join('; ')
}
