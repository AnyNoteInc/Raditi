import { describe, expect, it } from 'vitest'

import { createAppTheme } from './create-app-theme.ts'
import { brandColors } from './tokens.ts'

describe('createAppTheme', () => {
  it('builds the light scheme from the brand tokens', () => {
    const theme = createAppTheme('light')

    expect(theme.palette.mode).toBe('light')
    expect(theme.palette.primary.main).toBe(brandColors.accent)
    expect(theme.palette.primary.contrastText).toBe('#FFFFFF')
    expect(theme.palette.background.default).toBe(brandColors.paper)
    expect(theme.palette.background.paper).toBe(brandColors.card)
    expect(theme.palette.text.primary).toBe(brandColors.ink)
    expect(theme.palette.text.secondary).toBe(brandColors.graphite)
    expect(theme.palette.divider).toBe(brandColors.rule)
    expect(Object.keys(theme.colorSchemes)).toEqual(['light'])
  })

  it('builds the dark scheme with the marker as the accent', () => {
    const theme = createAppTheme('dark')

    expect(theme.palette.mode).toBe('dark')
    expect(theme.palette.primary.main).toBe(brandColors.marker)
    expect(theme.palette.primary.contrastText).toBe(brandColors.ink)
    expect(theme.palette.background.default).toBe(brandColors.ink)
    expect(theme.palette.background.paper).toBe(brandColors.ink2)
    expect(theme.palette.text.primary).toBe(brandColors.snow)
    expect(Object.keys(theme.colorSchemes)).toEqual(['dark'])
  })

  it('switches both schemes by prefers-color-scheme for the system preference', () => {
    const theme = createAppTheme('system')

    expect(theme.colorSchemeSelector).toBe('media')
    expect(theme.colorSchemes.light?.palette.primary.main).toBe(brandColors.accent)
    expect(theme.colorSchemes.dark?.palette.primary.main).toBe(brandColors.marker)
    expect(JSON.stringify(theme.generateStyleSheets())).toContain(
      '@media (prefers-color-scheme: dark)',
    )
  })

  it('defaults to the system preference', () => {
    expect(createAppTheme().colorSchemeSelector).toBe('media')
  })

  it('renders colours through CSS variables', () => {
    const theme = createAppTheme('light')

    expect(theme.vars.palette.primary.main).toMatch(/^var\(--mui-palette-primary-main/)
  })

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
