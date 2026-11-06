'use client'

import Box from '@mui/material/Box'
import type { ReactNode } from 'react'

import { ApplicationRail } from './application-rail'
import { applicationSurface } from './application-surface'
import { ApplicationToolbar, type Crumb } from './application-toolbar'
import { SkipLink } from './skip-link'
import type { ApplicationUser } from './user-avatar'

/** The list of projects: the page a shell without crumbs of its own stands for. */
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
      <ApplicationRail user={user} />
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
