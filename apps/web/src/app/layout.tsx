import '@fontsource-variable/golos-text'
import '@fontsource-variable/unbounded'
import '@fontsource-variable/jetbrains-mono'
import './globals.css'

import { parseThemePreference, THEME_COOKIE } from '@repo/ui/theme'
import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'

import { CookieBanner } from '@/components/public/cookie-banner'
import { env } from '@/env'
import { COOKIE_CONSENT_COOKIE, parseCookieConsent } from '@/lib/cookie-consent'

import { Providers } from './providers'

// Relative addresses of the metadata — the canonical one, the pictures of a preview — are
// resolved against the public address of the service, read when a page is rendered.
export const generateMetadata = (): Metadata => ({
  metadataBase: new URL(env.web().appUrl),
  title: { default: 'Радити', template: '%s — Радити' },
  description:
    'Радити — ИИ-помощник на каждый день: напишите в чат, что нужно сделать. Сервис готовится к запуску.',
  applicationName: 'Радити',
})

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The colour mode comes from the `theme` cookie only, so the first paint is already right.
  const cookieStore = await cookies()
  const themePreference = parseThemePreference(cookieStore.get(THEME_COOKIE)?.value)
  // Read on the server, so the cookie notice shows with the first paint and never flashes.
  const cookieChoice = parseCookieConsent(cookieStore.get(COOKIE_CONSENT_COOKIE)?.value)

  return (
    // Next 16 keeps the page's own scroll-behavior during navigation unless the root opts out:
    // the landing scrolls its anchors smoothly, route changes must still jump to the top.
    <html lang="ru" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body>
        <Providers themePreference={themePreference}>
          {children}
          <CookieBanner initiallyOpen={cookieChoice === null} />
        </Providers>
      </body>
    </html>
  )
}
