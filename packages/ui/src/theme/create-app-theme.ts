import type {} from '@mui/material/themeCssVarsAugmentation'
import { createTheme, type PaletteOptions, type Theme } from '@mui/material/styles'
import type { ElementType } from 'react'

import type { ThemePreference } from './theme-preference.ts'
import {
  actionColors,
  brandColorRoles,
  brandColors,
  brandCssVariables,
  fontFamilies,
  semanticColors,
} from './tokens.ts'

const lightPalette = {
  mode: 'light',
  common: { black: brandColors.ink, white: brandColors.white },
  action: actionColors.light,
  primary: { main: brandColors.accentText, contrastText: brandColors.white },
  secondary: { main: brandColors.ink, contrastText: brandColors.paper },
  success: { main: semanticColors.light.success, contrastText: brandColors.white },
  error: { main: semanticColors.light.error, contrastText: brandColors.white },
  warning: { main: semanticColors.light.warning, contrastText: brandColors.white },
  info: { main: semanticColors.light.info, contrastText: brandColors.white },
  background: { default: brandColors.paper, paper: brandColors.card },
  text: {
    primary: brandColors.ink,
    secondary: brandColors.graphite,
    disabled: brandColorRoles.inkMuted,
  },
  divider: brandColors.rule,
} satisfies PaletteOptions

// The same orange family in both schemes; peach keeps dark-surface actions legible.
const darkPalette = {
  mode: 'dark',
  common: { black: brandColors.ink, white: brandColors.white },
  action: actionColors.dark,
  primary: { main: brandColors.accentLight, contrastText: brandColors.ink },
  secondary: { main: brandColors.snow, contrastText: brandColors.ink },
  success: { main: semanticColors.dark.success, contrastText: brandColors.ink },
  error: { main: semanticColors.dark.error, contrastText: brandColors.ink },
  warning: { main: semanticColors.dark.warning, contrastText: brandColors.ink },
  info: { main: semanticColors.dark.info, contrastText: brandColors.ink },
  background: { default: brandColors.ink, paper: brandColors.ink2 },
  text: {
    primary: brandColors.snow,
    secondary: brandColors.onInk,
    disabled: brandColorRoles.snowMuted,
  },
  divider: brandColors.ruleInk,
} satisfies PaletteOptions

const heading = { fontFamily: fontFamilies.heading, fontWeight: 600 } as const

export type CreateAppThemeOptions = {
  /**
   * Router-aware link (next/link) for MUI `Link` and for buttons with `href`. It is passed in
   * so that ui does not import next.
   */
  linkComponent?: ElementType
}

/**
 * `light` and `dark` build a single-scheme theme; `system` builds both schemes switched by
 * `prefers-color-scheme`. Either way the server renders the right colours on the first paint,
 * so no script or local storage is needed.
 */
export function createAppTheme(
  preference: ThemePreference = 'system',
  options: CreateAppThemeOptions = {},
): Theme {
  const { linkComponent } = options
  const colorSchemes =
    preference === 'system'
      ? { light: { palette: lightPalette }, dark: { palette: darkPalette } }
      : preference === 'dark'
        ? { dark: { palette: darkPalette } }
        : { light: { palette: lightPalette } }

  return createTheme({
    cssVariables: true,
    colorSchemes,
    defaultColorScheme: preference === 'dark' ? 'dark' : 'light',
    shape: { borderRadius: 14 },
    focusVisible: true,
    typography: {
      fontFamily: fontFamilies.body,
      h1: { ...heading, fontSize: '3rem', lineHeight: 1.05, letterSpacing: '-0.035em' },
      h2: { ...heading, fontSize: '2.25rem', lineHeight: 1.1, letterSpacing: '-0.03em' },
      h3: { ...heading, fontSize: '1.75rem', lineHeight: 1.15, letterSpacing: '-0.02em' },
      h4: { ...heading, fontSize: '1.5rem', lineHeight: 1.2, letterSpacing: '-0.02em' },
      h5: { ...heading, fontSize: '1.25rem', lineHeight: 1.25, letterSpacing: '-0.02em' },
      h6: { ...heading, fontSize: '1.0625rem', lineHeight: 1.3, letterSpacing: '-0.01em' },
      button: { textTransform: 'none', fontWeight: 600, letterSpacing: 0 },
      overline: {
        fontFamily: fontFamilies.mono,
        fontWeight: 500,
        letterSpacing: '0.06em',
        lineHeight: 1.6,
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: { ':root': brandCssVariables },
      },
      MuiButtonBase: {
        defaultProps: linkComponent ? { LinkComponent: linkComponent } : {},
      },
      MuiLink: {
        // Colour alone does not tell links from graphite text (WCAG 1.4.1).
        defaultProps: {
          underline: 'always',
          ...(linkComponent ? { component: linkComponent } : {}),
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 999 },
          // Vivid fills have dark labels; text and outlined actions retain accessible text hues.
          contained: ({ ownerState }) =>
            ownerState.color === 'primary'
              ? {
                  backgroundColor: brandColors.accent,
                  color: brandColorRoles.onAccent,
                  border: `1px solid ${brandColors.accentText}`,
                  '&:hover:not(.Mui-disabled)': { backgroundColor: brandColorRoles.accentHover },
                  '&.Mui-disabled': { borderColor: 'transparent' },
                }
              : {},
          sizeMedium: { minHeight: 44, paddingInline: 18 },
          sizeLarge: { minHeight: 52, paddingInline: 26, fontSize: '1rem' },
        },
      },
      MuiPaper: {
        styleOverrides: { root: { backgroundImage: 'none' } },
      },
      MuiCard: {
        defaultProps: { variant: 'outlined' },
        styleOverrides: { root: { borderRadius: 22 } },
      },
      MuiAlert: {
        styleOverrides: { root: { alignItems: 'flex-start' } },
      },
    },
  })
}
