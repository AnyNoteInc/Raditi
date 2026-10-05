// @vitest-environment node
import CssBaseline from '@mui/material/CssBaseline'
import { alpha, getContrastRatio, ThemeProvider } from '@mui/material/styles'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { createAppTheme } from './create-app-theme.ts'
import { brandColorRoles, brandColors, brandCssVariables, semanticColors } from './tokens.ts'

describe('createAppTheme', () => {
  it('builds the light scheme from the brand tokens', () => {
    const theme = createAppTheme('light')

    expect(theme.palette.mode).toBe('light')
    expect(theme.palette.primary.main).toBe(brandColors.accentText)
    expect(theme.palette.primary.contrastText).toBe(brandColors.white)
    expect(theme.palette.background.default).toBe(brandColors.paper)
    expect(theme.palette.background.paper).toBe(brandColors.card)
    expect(theme.palette.text.primary).toBe(brandColors.ink)
    expect(theme.palette.text.secondary).toBe(brandColors.graphite)
    expect(theme.palette.divider).toBe(brandColors.rule)
    expect(Object.keys(theme.colorSchemes)).toEqual(['light'])
  })

  it('builds the dark scheme with an accessible warm accent', () => {
    const theme = createAppTheme('dark')

    expect(theme.palette.mode).toBe('dark')
    expect(theme.palette.primary.main).toBe(brandColors.accentLight)
    expect(theme.palette.primary.contrastText).toBe(brandColors.ink)
    expect(theme.palette.background.default).toBe(brandColors.ink)
    expect(theme.palette.background.paper).toBe(brandColors.ink2)
    expect(theme.palette.text.primary).toBe(brandColors.snow)
    expect(Object.keys(theme.colorSchemes)).toEqual(['dark'])
  })

  it('switches both schemes by prefers-color-scheme for the system preference', () => {
    const theme = createAppTheme('system')

    expect(theme.colorSchemeSelector).toBe('media')
    expect(theme.colorSchemes.light?.palette.primary.main).toBe(brandColors.accentText)
    expect(theme.colorSchemes.dark?.palette.primary.main).toBe(brandColors.accentLight)
    expect(JSON.stringify(theme.generateStyleSheets())).toContain(
      '@media (prefers-color-scheme: dark)',
    )
  })

  it('defaults to the system preference', () => {
    expect(createAppTheme().colorSchemeSelector).toBe('media')
  })

  it.each(['light', 'dark'] as const)(
    'keeps primary button labels and text actions readable in %s mode',
    (mode) => {
      const { palette } = createAppTheme(mode)
      expect(
        getContrastRatio(palette.primary.main, palette.primary.contrastText),
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        getContrastRatio(palette.primary.main, palette.background.paper),
      ).toBeGreaterThanOrEqual(4.5)
      expect(getContrastRatio(brandColors.accent, brandColorRoles.onAccent)).toBeGreaterThanOrEqual(
        4.5,
      )
    },
  )

  it('renders colours through CSS variables', () => {
    const theme = createAppTheme('light')

    expect(theme.vars.palette.primary.main).toMatch(/^var\(--mui-palette-primary-main/)
  })

  it.each(['light', 'dark', 'system'] as const)(
    'emits every shared brand variable into the initial server stylesheet for %s',
    (preference) => {
      const theme = createAppTheme(preference)
      const html = renderToStaticMarkup(
        createElement(ThemeProvider, {
          theme,
          storageManager: null,
          children: createElement(CssBaseline),
        }),
      ).replace(/\s+/g, '')

      expect(html).toContain(':root{--raditi-paper:')
      for (const [name, value] of Object.entries(brandCssVariables)) {
        expect(html).toContain(`${name}:${value.replace(/\s+/g, '')};`)
      }
      expect(brandCssVariables['--raditi-paper-2']).toBe(brandColors.paper2)
      expect(brandCssVariables['--raditi-ink-2']).toBe(brandColors.ink2)
      expect(brandCssVariables['--raditi-on-ink']).toBe(brandColors.onInk)
    },
  )

  it.each(['light', 'dark'] as const)('preserves the central semantic roles for %s', (mode) => {
    const theme = createAppTheme(mode)
    for (const role of ['success', 'error', 'warning', 'info'] as const) {
      expect(theme.palette[role].main).toBe(semanticColors[mode][role])
    }
    expect(theme.palette.text.disabled).toBe(
      mode === 'light' ? brandColorRoles.inkMuted : brandColorRoles.snowMuted,
    )
  })

  it.each(['light', 'dark'] as const)(
    'derives hover and selection from the brand foreground for %s',
    (mode) => {
      const { palette } = createAppTheme(mode)
      const foreground = mode === 'light' ? brandColors.ink : brandColors.snow

      expect(palette.action.hover).toBe(alpha(foreground, mode === 'light' ? 0.04 : 0.08))
      expect(palette.action.selected).toBe(alpha(foreground, mode === 'light' ? 0.08 : 0.16))
      expect(palette.common.black).toBe(brandColors.ink)
      expect(palette.common.white).toBe(brandColors.white)
    },
  )

  it('takes the fonts from the next/font variables, with fallbacks', () => {
    const { typography } = createAppTheme('light')

    expect(typography.fontFamily).toMatch(/^var\(--font-golos, "Golos Text"\)/)
    expect(typography.h1.fontFamily).toMatch(/^var\(--font-unbounded, "Unbounded"\)/)
    expect(typography.overline.fontFamily).toMatch(/^var\(--font-jetbrains, "JetBrains Mono"\)/)
    expect(typography.button.textTransform).toBe('none')
  })

  it('uses the given link component for MUI links and link buttons', () => {
    const RouterLink = () => null
    const theme = createAppTheme('light', { linkComponent: RouterLink })

    expect(theme.components?.MuiLink?.defaultProps).toMatchObject({ component: RouterLink })
    expect(theme.components?.MuiButtonBase?.defaultProps?.LinkComponent).toBe(RouterLink)
  })

  it('keeps plain anchors without a link component', () => {
    const theme = createAppTheme('light')

    expect(theme.components?.MuiLink?.defaultProps).not.toHaveProperty('component')
    expect(theme.components?.MuiButtonBase?.defaultProps).not.toHaveProperty('LinkComponent')
  })
})
