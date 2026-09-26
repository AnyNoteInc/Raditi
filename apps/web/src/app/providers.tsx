'use client'

import { UiProvider } from '@repo/ui/providers'
import type { ThemePreference } from '@repo/ui/theme'
import NextLink from 'next/link'
import type { ReactNode } from 'react'

/** Client-side providers for every page: MUI theme with next/link for links and buttons. */
export function Providers({
  themePreference,
  children,
}: {
  themePreference: ThemePreference
  children: ReactNode
}) {
  return (
    <UiProvider themePreference={themePreference} linkComponent={NextLink}>
      {children}
    </UiProvider>
  )
}
