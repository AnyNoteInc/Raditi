'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { ApplicationToolbar } from '@/components/application/application-toolbar'
import { PanelToggle } from '@/components/application/cabinet-panel'
import { CabinetPanel, CabinetShell } from '@/components/application/cabinet-shell'
import { PanelDrawer } from '@/components/application/panel-drawer'
import type { ApplicationUser } from '@/components/application/user-avatar'
import type { CabinetPanelState } from '@/lib/cabinet-panel'

import {
  activeSettingsEntry,
  settingsEntryFor,
  settingsNav,
  type SettingsNavEntry,
} from './settings-nav'

/** The sections that are switched on, in the panel and in the menu of a phone. */
function SettingsLinks({
  active,
  onPick,
}: {
  active: SettingsNavEntry | undefined
  onPick?: () => void
}) {
  return (
    <Box
      component="ul"
      sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 0.25 }}
    >
      {settingsNav
        .filter((entry) => entry.enabled)
        .map((entry) => {
          const current = entry === active
          return (
            <li key={entry.href}>
              <Box
                component={Link}
                href={entry.href}
                aria-current={current ? 'page' : undefined}
                onClick={onPick}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  minHeight: 44,
                  px: 1.5,
                  borderRadius: '10px',
                  fontSize: 14,
                  textDecoration: 'none',
                  color: current ? 'text.primary' : 'text.secondary',
                  fontWeight: current ? 600 : 500,
                  bgcolor: current ? 'action.selected' : 'transparent',
                  '&:hover': {
                    bgcolor: current ? 'action.selected' : 'action.hover',
                    color: 'text.primary',
                  },
                  '& svg': { color: current ? 'primary.main' : 'inherit' },
                }}
              >
                <AppIcon name={entry.icon} size={20} />
                {entry.label}
              </Box>
            </li>
          )
        })}
    </Box>
  )
}

/**
 * The settings pages (docs/plan/64-cabinet-navigation.md, Н1, Н2): the rail of the cabinet, the
 * sections of the settings in the panel beside it, breadcrumbs on top of the content. Below `md`
 * the sections open from a button in the bar.
 */
export function SettingsShell({
  user,
  panelState = 'open',
  panelWidth = null,
  children,
}: {
  user: ApplicationUser
  /** The state of the panel beside the rail, from its cookie. */
  panelState?: CabinetPanelState
  /** The width the viewer dragged the panel to, from its cookie; null — the default. */
  panelWidth?: number | null
  children: ReactNode
}) {
  const pathname = usePathname()
  // The breadcrumbs name the section of the page even before the panel lists it.
  const section = settingsEntryFor(pathname, settingsNav)
  const active = activeSettingsEntry(pathname, settingsNav)
  return (
    <CabinetShell
      user={user}
      panelState={panelState}
      panelWidth={panelWidth}
      skipTarget="settings-content"
      panel={
        <CabinetPanel label="Настройки">
          <Box sx={{ display: 'flex', alignItems: 'center', minHeight: 60, pl: 2.5, pr: 1.25 }}>
            <Typography component="h2" sx={{ flex: '1 1 auto', fontSize: 16, fontWeight: 600 }}>
              Настройки
            </Typography>
            <PanelToggle place="panel" />
          </Box>
          <Box component="nav" aria-label="Разделы настроек" sx={{ px: 1 }}>
            <SettingsLinks active={active} />
          </Box>
        </CabinetPanel>
      }
    >
      <ApplicationToolbar
        crumbs={[
          ...(section ? [{ label: 'Настройки', href: '/settings' }] : []),
          { label: section?.label ?? 'Настройки' },
        ]}
        linkUnderline="hover"
        start={
          <>
            <PanelDrawer label="Разделы настроек" current={section?.label ?? 'Настройки'}>
              {(close) => (
                <Box component="nav" aria-label="Разделы настроек">
                  <SettingsLinks active={active} onPick={close} />
                </Box>
              )}
            </PanelDrawer>
            <Box sx={{ display: { xs: 'none', md: 'flex' }, mr: 1, ml: -1 }}>
              <PanelToggle place="content" />
            </Box>
          </>
        }
        sx={{
          gap: 1,
          px: { xs: 2.5, sm: 4 },
          '& .MuiBreadcrumbs-root': { display: { xs: 'none', md: 'block' } },
        }}
      />
      <Box
        component="main"
        id="settings-content"
        tabIndex={-1}
        sx={{
          width: '100%',
          maxWidth: 864,
          mx: 'auto',
          boxSizing: 'border-box',
          px: { xs: 2.5, sm: 4 },
          pt: { xs: 4, sm: 5 },
          pb: { xs: 6, sm: 10 },
          outline: 'none',
        }}
      >
        {children}
      </Box>
    </CabinetShell>
  )
}
