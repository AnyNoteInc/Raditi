import '@fontsource-variable/golos-text'
import '@fontsource-variable/unbounded'
import '@fontsource-variable/jetbrains-mono'
import './globals.css'

import { parseThemePreference, THEME_COOKIE } from '@repo/ui/theme'
import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'

import { Providers } from './providers'

export const metadata: Metadata = {
  title: { default: 'Радити', template: '%s — Радити' },
  description:
    'Радити — поддержка сайтов для малого бизнеса: напишите в чат, что поменять на сайте. Сервис готовится к запуску.',
  applicationName: 'Радити',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The colour mode comes from the `theme` cookie only, so the first paint is already right.
  const themePreference = parseThemePreference((await cookies()).get(THEME_COOKIE)?.value)

  return (
    // Next 16 keeps the page's own scroll-behavior during navigation unless the root opts out:
    // the landing scrolls its anchors smoothly, route changes must still jump to the top.
    <html lang="ru" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body>
        <Providers themePreference={themePreference}>{children}</Providers>
      </body>
    </html>
  )
}
