'use client'

import Box from '@mui/material/Box'
import { BrandMark } from '@repo/ui/components'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { CreditRing } from '@/components/billing/credit-ring'

import { AppIcon, type AppIconName } from './app-icon'
import type { ApplicationUser } from './user-avatar'
import { UserMenu } from './user-menu'

/** The sections of the cabinet, in the order of the rail (docs/plan/61-chats-first.md, К3). */
const sections: readonly { href: string; label: string; icon: AppIconName }[] = [
  { href: '/chats', label: 'Чаты', icon: 'chat' },
  // Between «Чаты» and «Проекты» (owner's answer of 13.11.2026, docs/plan/69-pages.md, Ст30).
  { href: '/pages', label: 'Страницы', icon: 'pages' },
  { href: '/projects', label: 'Проекты', icon: 'projects' },
]

const within = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`)

/**
 * The rail of the cabinet: the mark, «Чаты», «Страницы» and «Проекты», the credits over the account menu. Its
 * width is `--app-rail-width` of the shell, which stands it in. The current section follows the
 * address.
 */
export function ApplicationRail({
  user,
  hiddenOnPhone = false,
}: {
  user: ApplicationUser
  /** An item that takes the whole phone screen: its way back stands in place of the rail. */
  hiddenOnPhone?: boolean
}) {
  const pathname = usePathname()
  return (
    <Box
      component="aside"
      aria-label="Боковая панель"
      sx={{
        position: 'fixed',
        inset: '0 auto 0 0',
        width: 'var(--app-rail-width)',
        height: '100dvh',
        display: { xs: hiddenOnPhone ? 'none' : 'flex', sm: 'flex' },
        flexDirection: 'column',
        alignItems: 'center',
        // From `md` the rail lies on the ground of the page, beside the cards (docs/plan/64, Н1).
        bgcolor: { xs: 'background.default', md: 'transparent' },
        borderRight: { xs: 1, md: 0 },
        borderColor: 'divider',
        zIndex: 1100,
        pt: 1.5,
        pl: 'env(safe-area-inset-left)',
        pb: 'max(12px, env(safe-area-inset-bottom))',
      }}
    >
      <Box
        component={Link}
        href="/chats"
        aria-label="Радити — главная страница"
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 44,
          height: 44,
          mb: 3,
          borderRadius: 2,
        }}
      >
        <BrandMark size={30} withWordmark={false} />
      </Box>
      <Box
        component="nav"
        aria-label="Основная навигация"
        sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.75 }}
      >
        {sections.map(({ href, label, icon }) => {
          const current = within(pathname, href)
          return (
            <Box
              key={href}
              component={Link}
              href={href}
              aria-label={label}
              aria-current={current ? 'page' : undefined}
              sx={{
                width: { xs: 48, sm: 60 },
                minHeight: { xs: 48, sm: 56 },
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0.5,
                borderRadius: '14px',
                color: 'text.secondary',
                fontSize: 11,
                lineHeight: '14px',
                fontWeight: 500,
                textDecoration: 'none',
                '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
                '&[aria-current="page"]': {
                  bgcolor: { xs: 'action.selected', md: 'background.paper' },
                  boxShadow: { md: 'inset 0 0 0 1px var(--mui-palette-divider)' },
                  color: 'text.primary',
                  fontWeight: 600,
                  '& svg': { color: 'primary.main' },
                },
              }}
            >
              <AppIcon name={icon} />
              {/* On the narrow rail of a phone the label is only read: the link is named by it. */}
              <Box
                component="span"
                aria-hidden="true"
                sx={{ display: { xs: 'none', sm: 'block' } }}
              >
                {label}
              </Box>
            </Box>
          )
        })}
      </Box>
      {/* The credits over the account menu, as on the page of a site (29.10.2026). */}
      <Box
        sx={{
          mt: 'auto',
          pt: 2,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 0.75,
        }}
      >
        <CreditRing placement="sidebar" />
        <UserMenu user={user} placement="sidebar" />
      </Box>
    </Box>
  )
}
