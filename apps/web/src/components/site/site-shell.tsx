'use client'

import Box from '@mui/material/Box'
import Drawer from '@mui/material/Drawer'
import MuiLink from '@mui/material/Link'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, type ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { applicationSurface } from '@/components/application/application-surface'
import { ApplicationToolbar } from '@/components/application/application-toolbar'
import { SkipLink } from '@/components/application/skip-link'
import type { ApplicationUser } from '@/components/application/user-avatar'
import { UserMenu } from '@/components/application/user-menu'

import {
  activeSiteSection,
  closedSectionsNote,
  hasSiteList,
  SITE_LIST_WIDTH,
  SITE_RAIL_WIDTH,
  siteEntryHref,
  siteItemOpen,
  siteNav,
  siteSectionAvailable,
  type SiteNavEntry,
} from './site-nav'

export type ShellSite = { id: string; name: string; url: string; status: string }

/** The phrase every closed item of the navigation is described by. */
const CLOSED_NOTE = 'site-closed-sections'

const RAIL = SITE_RAIL_WIDTH
const BOTTOM_BAR = 64
/**
 * The side paddings of the bar and the content. Between `sm` and `md` the rail already takes
 * 88px of a narrow screen, so the wide paddings start only at `md`.
 */
const SIDE_PADDING = { xs: 2, sm: 2.5, md: 4 }

/**
 * What a screen reader hears after the label of a closed item. The item is a plain span, on
 * which `aria-disabled` and `aria-describedby` announce nothing, so the state is in its text.
 */
const CLOSED_SUFFIX = ', раздел недоступен'

/** The closed state of an item in words: read aloud, takes no room and is not seen. */
function ClosedState() {
  return (
    <Box
      component="span"
      sx={{
        position: 'absolute',
        width: '1px',
        height: '1px',
        m: '-1px',
        p: 0,
        overflow: 'hidden',
        clip: 'rect(0 0 0 0)',
        whiteSpace: 'nowrap',
        border: 0,
      }}
    >
      {CLOSED_SUFFIX}
    </Box>
  )
}

/** The lock, not the colour, says that an item of the navigation is closed. */
function ClosedMark() {
  return (
    <Box
      component="span"
      sx={{
        position: 'absolute',
        right: -9,
        bottom: -4,
        display: 'flex',
        p: '1px',
        borderRadius: '50%',
        bgcolor: 'background.default',
      }}
    >
      <AppIcon name="lock" size={12} style={{ strokeWidth: 2.2 }} />
    </Box>
  )
}

/**
 * One labelled destination: the same look in the rail and in the bottom bar. A section the
 * status of the site closes keeps its place and its label, but is not a link.
 */
function SectionLink({
  site,
  entry,
  active,
}: {
  site: ShellSite
  entry: SiteNavEntry
  active: boolean
}) {
  const open = siteSectionAvailable(site.status, entry.section)
  const look = {
    flex: { xs: '1 1 0', sm: 'none' },
    minWidth: 0,
    width: { sm: 76 },
    minHeight: { xs: 52, sm: 64 },
    px: 0.25,
    py: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0.5,
    borderRadius: '12px',
    fontSize: 12,
    lineHeight: '14px',
    textAlign: 'center',
  } as const
  if (!open) {
    return (
      <Box
        component="span"
        aria-disabled="true"
        aria-describedby={CLOSED_NOTE}
        sx={{ ...look, color: 'text.secondary', cursor: 'not-allowed' }}
      >
        <Box component="span" sx={{ position: 'relative', display: 'flex' }}>
          <AppIcon name={entry.icon} size={22} />
          <ClosedMark />
        </Box>
        <span>
          {entry.label}
          <ClosedState />
        </span>
      </Box>
    )
  }
  return (
    <Box
      component={Link}
      href={siteEntryHref(site.id, entry.section)}
      aria-current={active ? 'page' : undefined}
      sx={{
        ...look,
        textDecoration: 'none',
        color: active ? 'primary.main' : 'text.primary',
        fontWeight: active ? 600 : 400,
        bgcolor: active ? 'action.selected' : 'transparent',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      <AppIcon name={entry.icon} size={22} />
      <span>{entry.label}</span>
    </Box>
  )
}

/**
 * The page of one site: a rail of its six sections with the site's mark on top, breadcrumbs
 * that lead back to the projects, and on a phone a bottom bar instead of the rail. Which of
 * the two is shown is decided by styles alone, so the first paint is right on every width.
 */
export function SiteShell({
  user,
  site,
  children,
}: {
  user: ApplicationUser
  site: ShellSite
  children: ReactNode
}) {
  const pathname = usePathname()
  const active = activeSiteSection(pathname, site.id)
  // A «list — content» section: from `md` its list column stands beside the rail, and the
  // content fills the height so that the section can place its own areas.
  const framed = hasSiteList(active)
  // An open item takes the whole phone screen: its back arrow leads to the list and the bar.
  const itemOpen = siteItemOpen(pathname, site.id)
  const [moreOpen, setMoreOpen] = useState(false)
  const secondary = siteNav.filter((entry) => !entry.primary)
  const inMore = secondary.some((entry) => entry.section === active)
  // Set while the status of the site leaves «Обзор» alone open.
  const closedNote = closedSectionsNote(site.status)
  // The first character whole: a name may start with one that takes two UTF-16 units.
  const mark = Array.from(site.name.trim())[0]?.toLocaleLowerCase('ru') || '•'

  return (
    <Box sx={{ ...applicationSurface, bgcolor: 'background.paper' }}>
      <SkipLink target="site-content" left={{ xs: 8, sm: RAIL + 12 }} />
      {closedNote ? (
        <span id={CLOSED_NOTE} hidden>
          {closedNote}
        </span>
      ) : null}

      <Box
        component="aside"
        aria-label="Боковая панель сайта"
        sx={{
          display: { xs: 'none', sm: 'flex' },
          position: 'fixed',
          inset: '0 auto 0 0',
          width: `calc(${RAIL}px + env(safe-area-inset-left))`,
          pl: 'env(safe-area-inset-left)',
          height: '100dvh',
          overflowY: 'auto',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 0.5,
          bgcolor: 'background.default',
          borderRight: 1,
          borderColor: 'divider',
          zIndex: 1100,
          pt: 1.5,
          pb: 'max(12px, env(safe-area-inset-bottom))',
        }}
      >
        <Box
          role="img"
          aria-label={`Сайт ${site.name}`}
          sx={{
            width: 44,
            height: 44,
            flex: 'none',
            mb: 1,
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            fontWeight: 700,
            fontSize: 20,
          }}
        >
          {mark}
        </Box>
        <Box
          component="nav"
          aria-label="Разделы сайта"
          sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}
        >
          {siteNav.map((entry) => (
            <SectionLink
              key={entry.section}
              site={site}
              entry={entry}
              active={entry.section === active}
            />
          ))}
        </Box>
        <Box sx={{ mt: 'auto', pt: 2 }}>
          <UserMenu user={user} placement="sidebar" />
        </Box>
      </Box>

      <Box
        sx={{
          ml: {
            xs: 'env(safe-area-inset-left)',
            sm: `calc(${RAIL}px + env(safe-area-inset-left))`,
            ...(framed && {
              md: `calc(${RAIL + SITE_LIST_WIDTH}px + env(safe-area-inset-left))`,
            }),
          },
          mr: 'env(safe-area-inset-right)',
          pb: {
            xs: itemOpen
              ? 'env(safe-area-inset-bottom)'
              : `calc(${BOTTOM_BAR}px + env(safe-area-inset-bottom))`,
            sm: 0,
          },
          minWidth: 0,
          ...(framed && { minHeight: '100dvh', display: 'flex', flexDirection: 'column' }),
        }}
      >
        <ApplicationToolbar
          label="Панель сайта"
          crumbs={[{ label: 'Проекты', href: '/projects' }, { label: site.name }]}
          end={
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <MuiLink
                href={site.url}
                target="_blank"
                rel="noopener noreferrer"
                variant="body2"
                aria-label={`Открыть сайт ${site.name} в новой вкладке`}
                sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minHeight: 44 }}
              >
                Открыть сайт
                <AppIcon name="arrow" size={16} />
              </MuiLink>
              <Box sx={{ display: { xs: 'block', sm: 'none' } }}>
                <UserMenu user={user} placement="toolbar" />
              </Box>
            </Box>
          }
          sx={{
            px: SIDE_PADDING,
            py: 1.25,
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            gap: '8px 16px',
          }}
        />
        <Box
          component="main"
          id="site-content"
          tabIndex={-1}
          sx={{
            px: SIDE_PADDING,
            py: { xs: 3, md: 3.5 },
            minWidth: 0,
            outline: 'none',
            ...(framed && { flex: '1 0 auto', display: 'flex', flexDirection: 'column' }),
          }}
        >
          {children}
        </Box>
      </Box>

      <Box
        component="nav"
        aria-label="Разделы сайта"
        sx={{
          display: { xs: itemOpen ? 'none' : 'flex', sm: 'none' },
          position: 'fixed',
          inset: 'auto 0 0 0',
          zIndex: 1100,
          gap: 0.25,
          px: 0.75,
          pt: 0.75,
          pb: 'max(8px, env(safe-area-inset-bottom))',
          pl: 'max(6px, env(safe-area-inset-left))',
          pr: 'max(6px, env(safe-area-inset-right))',
          bgcolor: 'background.default',
          borderTop: 1,
          borderColor: 'divider',
        }}
      >
        {siteNav
          .filter((entry) => entry.primary)
          .map((entry) => (
            <SectionLink
              key={entry.section}
              site={site}
              entry={entry}
              active={entry.section === active}
            />
          ))}
        <Box
          component="button"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
          sx={{
            flex: '1 1 0',
            minWidth: 0,
            minHeight: 52,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0.5,
            border: 0,
            borderRadius: '12px',
            font: 'inherit',
            fontSize: 12,
            lineHeight: '14px',
            cursor: 'pointer',
            color: inMore ? 'primary.main' : 'text.primary',
            fontWeight: inMore ? 600 : 400,
            bgcolor: inMore ? 'action.selected' : 'transparent',
          }}
        >
          <AppIcon name="more" size={22} style={{ strokeWidth: 2.4 }} />
          <span>Ещё</span>
        </Box>
      </Box>

      <Drawer
        anchor="bottom"
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        slotProps={{
          paper: { 'aria-label': 'Ещё разделы', sx: { borderRadius: '14px 14px 0 0' } },
        }}
      >
        <Box
          component="nav"
          aria-label="Ещё разделы"
          sx={{
            display: 'flex',
            flexDirection: 'column',
            p: 1.5,
            pb: 'max(16px, env(safe-area-inset-bottom))',
          }}
        >
          {[
            ...secondary.map((entry) => ({
              href: siteEntryHref(site.id, entry.section),
              label: entry.label,
              icon: entry.icon,
              current: entry.section === active,
              open: siteSectionAvailable(site.status, entry.section),
            })),
            {
              href: '/projects',
              label: 'К проектам',
              icon: 'projects' as const,
              current: false,
              open: true,
            },
          ].map((item) => {
            const look = {
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              minHeight: 48,
              px: 1.5,
              borderRadius: '12px',
            } as const
            return item.open ? (
              <Box
                key={item.href}
                component={Link}
                href={item.href}
                aria-current={item.current ? 'page' : undefined}
                onClick={() => setMoreOpen(false)}
                sx={{
                  ...look,
                  textDecoration: 'none',
                  color: item.current ? 'primary.main' : 'text.primary',
                  fontWeight: item.current ? 600 : 400,
                  bgcolor: item.current ? 'action.selected' : 'transparent',
                }}
              >
                <AppIcon name={item.icon} />
                {item.label}
              </Box>
            ) : (
              <Box
                key={item.href}
                component="span"
                aria-disabled="true"
                aria-describedby={CLOSED_NOTE}
                sx={{ ...look, color: 'text.secondary', cursor: 'not-allowed' }}
              >
                <AppIcon name={item.icon} />
                <span>
                  {item.label}
                  <ClosedState />
                </span>
                <Box component="span" sx={{ display: 'flex', ml: 'auto' }}>
                  <AppIcon name="lock" size={16} />
                </Box>
              </Box>
            )
          })}
        </Box>
      </Drawer>
    </Box>
  )
}
