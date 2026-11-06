'use client'

import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
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
  { href: '/projects', label: 'Проекты', icon: 'projects' },
]

const within = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`)

/**
 * The rail of the cabinet: the mark, «Чаты» and «Проекты», the credits over the account menu. Its
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
        bgcolor: 'background.default',
        borderRight: 1,
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
        sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}
      >
        {sections.map(({ href, label, icon }) => {
          const current = within(pathname, href)
          return (
            <Tooltip key={href} title={label} placement="right">
              <IconButton
                component={Link}
                href={href}
                aria-label={label}
                aria-current={current ? 'page' : undefined}
                sx={{
                  width: 44,
                  height: 44,
                  borderRadius: '12px',
                  color: 'text.secondary',
                  '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
                  '&[aria-current="page"]': {
                    bgcolor: 'action.selected',
                    color: 'primary.main',
                  },
                }}
              >
                <AppIcon name={icon} />
              </IconButton>
            </Tooltip>
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
