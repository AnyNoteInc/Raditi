// @vitest-environment node
import CssBaseline from '@mui/material/CssBaseline'
import { alpha, createTheme, getContrastRatio, ThemeProvider } from '@mui/material/styles'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { createAppTheme } from './create-app-theme.ts'
import {
  brandColorRoles,
  brandColors,
  brandCssVariables,
  motionTokens,
  semanticColors,
} from './tokens.ts'

/** The colour of a role mixed in CSS from two palette tokens, as a browser computes it in sRGB. */
function mixed(role: string): string {
  const match =
    /^color-mix\(in srgb, var\((--raditi-[a-z0-9-]+)\) (\d+)%, var\((--raditi-[a-z0-9-]+)\)\)$/.exec(
      role,
    )
  if (!match) throw new Error(`Not a mix of two palette tokens: ${role}`)
  const [, first, percent, second] = match
  const share = Number(percent) / 100
  const channels = (name: string | undefined) => {
    const hex = name ? brandCssVariables[name as `--raditi-${string}`] : undefined
    if (!hex || !/^#[0-9A-F]{6}$/.test(hex)) throw new Error(`Not a base colour: ${name}`)
    return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
  }
  const [from, to] = [channels(first), channels(second)]
  const mix = from.map((value, index) => Math.round(value * share + (to[index] ?? 0) * (1 - share)))
  return `rgb(${mix.join(', ')})`
}

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

  it('derives the outline of a control from the palette, at 3:1 against the light surfaces', () => {
    const outline = mixed(brandColorRoles.ruleStrong)

    expect(brandCssVariables['--raditi-rule-strong']).toBe(brandColorRoles.ruleStrong)
    for (const surface of [brandColors.paper, brandColors.paper2, brandColors.card]) {
      expect(getContrastRatio(outline, surface)).toBeGreaterThanOrEqual(3)
    }
    // The divider it replaces on controls stays a decoration.
    expect(getContrastRatio(brandColors.rule, brandColors.paper)).toBeLessThan(3)
    // Not for the amber fields.
    expect(getContrastRatio(outline, brandColors.marker)).toBeLessThan(3)
  })

  it('keeps the hover of the vivid fill readable and apart from the fill at rest', () => {
    const hover = mixed(brandColorRoles.accentHover)

    expect(getContrastRatio(hover, brandColorRoles.onAccent)).toBeGreaterThanOrEqual(4.5)
    // At 85% of the accent the two fills were 1.08:1 apart and could not be told from each other.
    expect(getContrastRatio(hover, brandColors.accent)).toBeGreaterThanOrEqual(1.2)
    // White never stands on the fill, hovered or not.
    expect(getContrastRatio(hover, brandColors.white)).toBeLessThan(4.5)
  })

  it.each(['light', 'dark'] as const)(
    'gives the contained primary button the vivid fill and its hover in %s mode',
    (mode) => {
      const theme = createAppTheme(mode)
      const contained = theme.components?.MuiButton?.styleOverrides?.contained
      if (typeof contained !== 'function') throw new Error('No rule for the contained button')
      const rule = contained({ ownerState: { color: 'primary' }, theme } as never)

      expect(rule).toMatchObject({
        backgroundColor: brandColors.accent,
        color: brandColors.ink,
        '&:hover:not(.Mui-disabled)': { backgroundColor: brandColorRoles.accentHover },
      })
    },
  )

  it('publishes one radius for pills and no shadow role that repeats another', () => {
    expect(brandCssVariables['--raditi-radius-pill']).toBe('999px')
    expect(createAppTheme('light').components?.MuiButton?.styleOverrides?.root).toMatchObject({
      borderRadius: Number.parseInt(brandCssVariables['--raditi-radius-pill'] ?? '', 10),
    })
    // The medium shadow stood one hundredth of opacity from the soft one.
    expect(Object.keys(brandCssVariables).filter((name) => name.includes('shadow'))).toEqual([
      '--raditi-shadow-soft',
      '--raditi-shadow-strong',
    ])
  })

  it('publishes the curves and the short durations of controls apart from the palette', () => {
    expect(brandCssVariables['--raditi-ease-out']).toBe('cubic-bezier(0.16, 1, 0.3, 1)')
    expect(brandCssVariables['--raditi-ease-in-out']).toBe('cubic-bezier(0.65, 0, 0.35, 1)')
    expect(brandCssVariables['--raditi-motion-press']).toBe('90ms')
    expect(brandCssVariables['--raditi-motion-fast']).toBe('160ms')
    expect(brandCssVariables['--raditi-motion-base']).toBe('240ms')
    // A press is shorter than its release, a hover shorter than a change of state.
    const [press, fast, base] = [
      motionTokens.motionPress,
      motionTokens.motionFast,
      motionTokens.motionBase,
    ].map((duration) => Number.parseInt(duration, 10))
    expect(press).toBeLessThan(fast ?? 0)
    expect(fast).toBeLessThan(base ?? 0)
    // A token of motion is no colour and no role of one.
    for (const key of Object.keys(motionTokens)) {
      expect({ ...brandColors, ...brandColorRoles }).not.toHaveProperty(key)
    }
    // The cabinet and the forms keep the transitions of MUI: the scale is for the landing.
    expect(createAppTheme('light').transitions.duration).toEqual(createTheme().transitions.duration)
    expect(createAppTheme('light').transitions.easing).toEqual(createTheme().transitions.easing)
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
