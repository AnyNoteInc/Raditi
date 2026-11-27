import { parseThemePreference, THEME_COOKIE } from '@repo/ui/theme'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'

import { Providers } from './providers'

/**
 * MUI and its theme for the routes drawn with it — the cabinet, the sign-in, the onboarding, the
 * legal pages, the pages of an error (docs/plan/96-review-fixes.md, P33.2). The landing is drawn
 * with CSS modules and goes without them. The colour mode comes from the `theme` cookie only, so
 * the first paint is already right.
 */
export async function UiProviders({ children }: { children: ReactNode }) {
  const themePreference = parseThemePreference((await cookies()).get(THEME_COOKIE)?.value)
  return <Providers themePreference={themePreference}>{children}</Providers>
}
