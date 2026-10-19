'use client'

import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import { BrandMark } from '@repo/ui/components'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { AppIcon } from './app-icon'
import { applicationSurface } from './application-surface'
import { ApplicationToolbar, type Crumb } from './application-toolbar'
import { SkipLink } from './skip-link'
import type { ApplicationUser } from './user-avatar'
import { UserMenu } from './user-menu'

/** The list of projects: the page the rail's only item leads to. */
const PROJECTS_CRUMBS: readonly Crumb[] = [{ label: 'Проекты' }]

/** The project workspace: persistent rail, breadcrumb toolbar and one account menu. */
export function ApplicationShell({
  user,
  crumbs = PROJECTS_CRUMBS,
  children,
}: {
  user: ApplicationUser
  /** Where the page is; a page below the list leads back to it through the first crumb. */
  crumbs?: readonly Crumb[]
  children: ReactNode
}) {
  return (
    <Box
      sx={{
        ...applicationSurface,
        '--app-rail-width': { xs: '56px', sm: '72px' },
        bgcolor: 'background.paper',
      }}
    >
      <SkipLink target="application-content" left={84} />
      <Box
        component="aside"
        aria-label="Боковая панель"
        sx={{
          position: 'fixed',
          inset: '0 auto 0 0',
          width: 'var(--app-rail-width)',
          height: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          bgcolor: 'background.default',
          borderRight: 1,
          borderColor: 'divider',
          zIndex: 1100,
          pt: 1.5,
          pb: 'max(12px, env(safe-area-inset-bottom))',
        }}
      >
        <Box
          component={Link}
          href="/"
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
          <Tooltip title="Проекты" placement="right">
            <IconButton
              component={Link}
              href="/projects"
              aria-label="Проекты"
              aria-current="page"
              sx={{
                width: 44,
                height: 44,
                borderRadius: '12px',
                color: 'primary.main',
                bgcolor: 'action.selected',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <AppIcon name="projects" />
            </IconButton>
          </Tooltip>
        </Box>
        <Box sx={{ mt: 'auto', pt: 2 }}>
          <UserMenu user={user} placement="sidebar" />
        </Box>
      </Box>
      <Box sx={{ ml: 'var(--app-rail-width)', minWidth: 0 }}>
        <ApplicationToolbar
          crumbs={crumbs}
          sx={{ px: { xs: 2.5, sm: 4, lg: 6 }, bgcolor: 'background.paper' }}
        />
        <Box
          component="main"
          id="application-content"
          tabIndex={-1}
          sx={{ px: { xs: 2.5, sm: 4, lg: 6 }, py: { xs: 4, md: 5 }, minWidth: 0, outline: 'none' }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  )
}
