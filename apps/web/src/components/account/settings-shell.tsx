'use client'

import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import { useTheme, type Theme } from '@mui/material/styles'
import Tooltip from '@mui/material/Tooltip'
import useMediaQuery from '@mui/material/useMediaQuery'
import { BrandMark } from '@repo/ui/components'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useId, useSyncExternalStore, type ReactNode } from 'react'

import { AppIcon, type AppIconName } from '@/components/application/app-icon'
import { applicationSurface } from '@/components/application/application-surface'
import { ApplicationToolbar } from '@/components/application/application-toolbar'
import { SkipLink } from '@/components/application/skip-link'
import type { ApplicationUser } from '@/components/application/user-avatar'
import { UserMenu } from '@/components/application/user-menu'
import {
  readSettingsSidebarState,
  serializeSettingsSidebarCookie,
  type SettingsSidebarState,
} from '@/lib/settings-sidebar'

import { activeSettingsEntry, settingsEntryFor, settingsNav } from './settings-nav'

const RAIL_WIDTH = 72
const COMPACT_RAIL_WIDTH = 56
const ITEM_SIZE = 44

/** The sidebar's parts read their sizes from these variables, so its states differ only here. */
const expanded = {
  '--settings-sidebar-width': '264px',
  '--settings-sidebar-gutter': '12px',
  '--settings-rule-inset': '0px',
  '--settings-user-height': '52px',
  '--settings-label-opacity': '1',
}

/**
 * A rail is the same sidebar narrowed to its icons: the gutters leave 44px beside the 1px border,
 * and the labels are faded and clipped, not removed, so the names stay in the markup.
 */
const rail = (width: number): typeof expanded => ({
  '--settings-sidebar-width': `${width}px`,
  '--settings-sidebar-gutter': `${(width - 1 - ITEM_SIZE) / 2}px`,
  '--settings-rule-inset': '8px',
  '--settings-user-height': `${ITEM_SIZE}px`,
  '--settings-label-opacity': '0',
})

/** Below `md` the page has no room for the full sidebar: it is always a rail, without a toggle. */
const narrowScreen = (theme: Theme) => theme.breakpoints.down('md')

const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The cookie is the state. The server passes what it read from it, so hydration matches the
 * markup; a layout that the router restores from its cache still shows the latest choice.
 */
function useSidebarState(serverState: SettingsSidebarState) {
  const state = useSyncExternalStore(
    subscribe,
    () => readSettingsSidebarState(document.cookie),
    () => serverState,
  )
  const setState = (next: SettingsSidebarState) => {
    document.cookie = serializeSettingsSidebarCookie(next, {
      secure: window.location.protocol === 'https:',
    })
    for (const listener of listeners) listener()
  }
  return [state, setState] as const
}

function SidebarLink({
  href,
  label,
  icon,
  current = false,
  iconOnly,
}: {
  href: string
  label: string
  icon: AppIconName
  current?: boolean
  /** In a rail the label is hidden, so it comes back as a tooltip. */
  iconOnly: boolean
}) {
  return (
    <Tooltip title={iconOnly ? label : ''} placement="right">
      <ButtonBase
        component={Link}
        href={href}
        aria-label={label}
        aria-current={current ? 'page' : undefined}
        sx={{
          justifyContent: 'flex-start',
          gap: 1.5,
          minHeight: ITEM_SIZE,
          px: 1.5,
          overflow: 'hidden',
          borderRadius: '12px',
          color: 'text.secondary',
          typography: 'body2',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
          '&[aria-current="page"]': {
            bgcolor: 'action.selected',
            color: 'primary.main',
            fontWeight: 600,
          },
        }}
      >
        <AppIcon name={icon} />
        <Box component="span" sx={{ opacity: 'var(--settings-label-opacity)' }}>
          {label}
        </Box>
      </ButtonBase>
    </Tooltip>
  )
}

/**
 * The settings pages: a sidebar with the sections that collapses to a rail, breadcrumbs on top
 * and the account menu at the sidebar's foot.
 */
export function SettingsShell({
  user,
  sidebar,
  children,
}: {
  user: ApplicationUser
  /** The state from the sidebar cookie, parsed on the server with `parseSettingsSidebarState`. */
  sidebar: SettingsSidebarState
  children: ReactNode
}) {
  const sidebarId = useId()
  const pathname = usePathname()
  const [state, setState] = useSidebarState(sidebar)
  const collapsed = state === 'collapsed'
  // The sizes come from CSS alone, so the first paint is right on a narrow screen too; the
  // query only decides what a rail adds on top of them: tooltips and the avatar-only menu.
  const narrow = useMediaQuery(narrowScreen(useTheme()))
  const iconOnly = collapsed || narrow
  // The breadcrumbs name the section of the page even before the sidebar lists it.
  const section = settingsEntryFor(pathname, settingsNav)
  const active = activeSettingsEntry(pathname, settingsNav)
  const toggleLabel = collapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель'

  return (
    <Box
      sx={(theme) => ({
        ...applicationSurface,
        ...(collapsed ? rail(RAIL_WIDTH) : expanded),
        // A narrow screen overrides the choice; its rail has the widths of the projects page.
        [narrowScreen(theme)]: rail(RAIL_WIDTH),
        [theme.breakpoints.down('sm')]: rail(COMPACT_RAIL_WIDTH),
        display: 'flex',
        alignItems: 'stretch',
        bgcolor: 'background.paper',
      })}
    >
      <SkipLink target="settings-content" left="calc(var(--settings-sidebar-width) + 12px)" />
      <Box
        component="aside"
        id={sidebarId}
        aria-label="Боковая панель"
        sx={{
          flex: '0 0 var(--settings-sidebar-width)',
          width: 'var(--settings-sidebar-width)',
          bgcolor: 'background.default',
          borderRight: 1,
          borderColor: 'divider',
          '@media (prefers-reduced-motion: no-preference)': {
            transition: 'flex-basis 180ms ease, width 180ms ease',
          },
        }}
      >
        <Box
          sx={{
            position: 'sticky',
            top: 0,
            display: 'flex',
            flexDirection: 'column',
            height: '100dvh',
            overflowY: 'auto',
            pt: '10px',
            px: 'var(--settings-sidebar-gutter)',
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
              flexShrink: 0,
              minHeight: ITEM_SIZE,
              px: '7px',
              overflow: 'hidden',
              borderRadius: '12px',
              textDecoration: 'none',
            }}
          >
            <BrandMark size={30} />
          </Box>
          <Box
            component="nav"
            aria-label="Разделы настроек"
            sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 2 }}
          >
            <SidebarLink href="/projects" label="К проектам" icon="back" iconOnly={iconOnly} />
            <Divider aria-hidden="true" sx={{ my: 1, mx: 'var(--settings-rule-inset)' }} />
            {settingsNav
              .filter((entry) => entry.enabled)
              .map((entry) => (
                <SidebarLink
                  key={entry.href}
                  href={entry.href}
                  label={entry.label}
                  icon={entry.icon}
                  current={entry === active}
                  iconOnly={iconOnly}
                />
              ))}
          </Box>
          <Box
            sx={{
              mt: 'auto',
              pt: 2,
              // Before hydration a narrow screen shows the wide block clipped to the avatar.
              '& > button': { minHeight: 'var(--settings-user-height)' },
            }}
          >
            <UserMenu user={user} placement={iconOnly ? 'sidebar' : 'panel'} />
          </Box>
        </Box>
      </Box>
      <Box sx={{ flex: '1 1 0', minWidth: 0 }}>
        <ApplicationToolbar
          crumbs={[
            ...(section ? [{ label: 'Настройки', href: '/settings' }] : []),
            { label: section?.label ?? 'Настройки' },
          ]}
          linkUnderline="hover"
          start={
            <Tooltip title={toggleLabel}>
              <IconButton
                aria-label={toggleLabel}
                aria-expanded={!collapsed}
                aria-controls={sidebarId}
                onClick={() => setState(collapsed ? 'expanded' : 'collapsed')}
                sx={(theme) => ({
                  width: ITEM_SIZE,
                  height: ITEM_SIZE,
                  borderRadius: '12px',
                  color: 'text.secondary',
                  '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
                  [narrowScreen(theme)]: { display: 'none' },
                })}
              >
                <AppIcon name="panel" />
              </IconButton>
            </Tooltip>
          }
          sx={{
            gap: 1,
            // Without the toggle the breadcrumbs line up with the page below them.
            pl: { xs: 2.5, sm: 4, md: 1.5 },
            pr: { xs: 2.5, sm: 4 },
          }}
        />
        <Box
          component="main"
          id="settings-content"
          tabIndex={-1}
          sx={{
            maxWidth: 864,
            mx: 'auto',
            px: { xs: 2.5, sm: 4 },
            pt: { xs: 4, sm: 5 },
            pb: { xs: 6, sm: 10 },
            outline: 'none',
          }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  )
}
