import '@fontsource-variable/golos-text'
import '@fontsource-variable/unbounded'
import '@fontsource-variable/jetbrains-mono'
import './globals.css'

import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'

import { CookieBanner } from '@/components/public/cookie-banner'
import { env } from '@/env'
import { brandVariablesCss } from '@/lib/brand-variables'
import { COOKIE_CONSENT_COOKIE, parseCookieConsent } from '@/lib/cookie-consent'

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
  // MUI and its theme stand in the layouts of the routes drawn with it (`UiProviders`): the
  // landing goes without them (docs/plan/96-review-fixes.md, P33.2).
  const cookieStore = await cookies()
  // Read on the server, so the cookie notice shows with the first paint and never flashes.
  const cookieChoice = parseCookieConsent(cookieStore.get(COOKIE_CONSENT_COOKIE)?.value)

  return (
    // Next 16 keeps the page's own scroll-behavior during navigation unless the root opts out:
    // the landing scrolls its anchors smoothly, route changes must still jump to the top.
    <html lang="ru" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        {/* The brand variables on every page, with or without the theme of the cabinet. */}
        <style dangerouslySetInnerHTML={{ __html: brandVariablesCss() }} />
      </head>
      <body>
        {children}
        <CookieBanner initiallyOpen={cookieChoice === null} />
      </body>
    </html>
  )
}
