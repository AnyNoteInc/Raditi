import { brandColors, brandCssVariables } from '@repo/ui/theme/tokens'
import { describe, expect, it } from 'vitest'

import { brandVariablesCss } from './brand-variables'

describe('brandVariablesCss', () => {
  it('writes every brand variable into one rule of the root', () => {
    const css = brandVariablesCss()

    expect(css.startsWith(':root{')).toBe(true)
    expect(css.endsWith('}')).toBe(true)
    for (const [name, value] of Object.entries(brandCssVariables))
      expect(css).toContain(`${name}:${value}`)
    expect(css).toContain(`--raditi-paper:${brandColors.paper}`)
  })

  it('holds nothing that closes the style element early', () => {
    expect(brandVariablesCss()).not.toMatch(/<\/?style/i)
  })
})
