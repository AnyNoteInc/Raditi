'use client'

import { UiProvider } from '@repo/ui/providers'
import NextLink from 'next/link'

import { UserMenu } from '@/components/application/user-menu'
import type { ApplicationUser } from '@/components/application/user-avatar'

/**
 * The account menu in the landing's header: the one menu of the landing drawn with MUI. It brings
 * MUI and its theme with it, in a chunk only a signed-in visitor loads; the landing is light in
 * every theme, and so is its menu (docs/plan/96-review-fixes.md, P33.2).
 */
export function LandingUserMenu({ user }: { user: ApplicationUser }) {
  return (
    <UiProvider themePreference="light" linkComponent={NextLink}>
      <UserMenu user={user} landing />
    </UiProvider>
  )
}
