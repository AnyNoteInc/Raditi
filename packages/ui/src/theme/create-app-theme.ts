import type {} from '@mui/material/themeCssVarsAugmentation'
import { createTheme, type PaletteOptions, type Theme } from '@mui/material/styles'
import type { ElementType } from 'react'

import type { ThemePreference } from './theme-preference.ts'
import { brandColors, fontFamilies } from './tokens.ts'

const lightPalette = {
  mode: 'light',
  primary: { main: brandColors.accent, contrastText: '#FFFFFF' },
  secondary: { main: brandColors.ink, contrastText: brandColors.paper },
  success: { main: brandColors.ok, contrastText: '#FFFFFF' },
  error: { main: '#B42318', contrastText: '#FFFFFF' },
  warning: { main: '#B54708', contrastText: '#FFFFFF' },
  info: { main: brandColors.accent, contrastText: '#FFFFFF' },
  background: { default: brandColors.paper, paper: brandColors.card },
  text: {
    primary: brandColors.ink,
    secondary: brandColors.graphite,
    disabled: 'rgba(21, 23, 26, 0.38)',
  },
  divider: brandColors.rule,
} satisfies PaletteOptions

// Dark sections of the landing put the yellow marker where the light ones use the blue accent.
const darkPalette = {
  mode: 'dark',
  primary: { main: brandColors.marker, contrastText: brandColors.ink },
  secondary: { main: brandColors.snow, contrastText: brandColors.ink },
  success: { main: '#4CC38A', contrastText: brandColors.ink },
  error: { main: '#F97066', contrastText: brandColors.ink },
  warning: { main: '#F5B94A', contrastText: brandColors.ink },
  info: { main: '#9AA2FF', contrastText: brandColors.ink },
  background: { default: brandColors.ink, paper: brandColors.ink2 },
  text: {
    primary: brandColors.snow,
    secondary: brandColors.onInk,
    disabled: 'rgba(241, 242, 238, 0.38)',
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
