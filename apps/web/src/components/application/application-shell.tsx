'use client'

import Box from '@mui/material/Box'
import type { ReactNode } from 'react'

import { ApplicationToolbar, type Crumb } from './application-toolbar'
import { CabinetShell } from './cabinet-shell'
import type { ApplicationUser } from './user-avatar'

/** The list of projects: the page a shell without crumbs of its own stands for. */
const PROJECTS_CRUMBS: readonly Crumb[] = [{ label: 'Проекты' }]

/**
 * A page of the cabinet without a panel — the projects and a new project: the rail, breadcrumbs
 * on top of the content card, one account menu (docs/plan/64-cabinet-navigation.md, Н1).
 */
export function ApplicationShell({
  user,
  crumbs = PROJECTS_CRUMBS,
  toolbar = true,
  children,
}: {
  user: ApplicationUser
  /** Where the page is; a page below the list leads back to it through the first crumb. */
  crumbs?: readonly Crumb[]
  /** A page that names itself in a heading of its own goes without the bar of breadcrumbs. */
  toolbar?: boolean
  children: ReactNode
}) {
  return (
    <CabinetShell user={user} skipTarget="application-content">
      {toolbar ? (
        <ApplicationToolbar crumbs={crumbs} sx={{ px: { xs: 2.5, sm: 4, lg: 6 } }} />
      ) : null}
      <Box
        component="main"
        id="application-content"
        tabIndex={-1}
        sx={{
          flex: '1 0 auto',
          display: 'flex',
          flexDirection: 'column',
          px: { xs: 2.5, sm: 4, lg: 6 },
          py: { xs: 4, md: 5 },
          minWidth: 0,
          outline: 'none',
        }}
      >
        {children}
      </Box>
    </CabinetShell>
  )
}
