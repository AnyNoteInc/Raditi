import { brandCssVariables } from '@repo/ui/theme/tokens'

/**
 * The brand variables (`--raditi-*`) as one rule of the root, written by the root layout: every
 * page has them, the landing and the cookie notice too, which have no MUI theme to emit them
 * (docs/plan/96-review-fixes.md, P33.2). The theme of the cabinet emits the same values.
 */
export function brandVariablesCss(): string {
  const declarations = Object.entries(brandCssVariables)
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
  return `:root{${declarations}}`
}
