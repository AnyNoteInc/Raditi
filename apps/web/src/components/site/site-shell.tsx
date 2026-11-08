'use client'

import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Typography from '@mui/material/Typography'
import { statusDotColors } from '@repo/ui/theme/tokens'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { ApplicationToolbar } from '@/components/application/application-toolbar'
import { PanelToggle } from '@/components/application/cabinet-panel'
import { CabinetPanel, CabinetShell } from '@/components/application/cabinet-shell'
import { PanelDrawer } from '@/components/application/panel-drawer'
import type { ApplicationUser } from '@/components/application/user-avatar'
import { newChatHref } from '@/components/chat/chat-address'
import { statusLabels } from '@/components/projects/project-labels'
import type { CabinetPanelState } from '@/lib/cabinet-panel'

import {
  activeSiteSection,
  closedSectionsNote,
  inSiteSetup,
  siteHref,
  siteNav,
  siteSectionAvailable,
  takesNewChat,
  type SiteChat,
  type SiteNavEntry,
  type SiteSetup,
} from './site-nav'
import { SiteMark } from './site-mark'

export type ShellSite = {
  id: string
  name: string
  url: string
  status: string
  /** Absent or null: a site from before the wizard, shown as it was. */
  setup?: SiteSetup
  /** What a new chat of it takes now; without it no chat is offered from the panel. */
  chat?: SiteChat
}

/** The phrase every closed item of the navigation is described by. */
const CLOSED_NOTE = 'site-closed-sections'

/** The side paddings of the bar and the content. */
const SIDE_PADDING = { xs: 2, sm: 2.5, md: 4 }

/**
 * What a screen reader hears after the label of a closed item. The item is a plain span, on
 * which `aria-disabled` and `aria-describedby` announce nothing, so the state is in its text.
 */
const CLOSED_SUFFIX = ', раздел недоступен'

const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  m: '-1px',
  p: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const

/** The colour of the dot beside the status of the site. */
const statusDot: Readonly<Record<string, string>> = {
  active: statusDotColors.ok,
  onboarding: statusDotColors.waiting,
  disconnected: statusDotColors.broken,
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * One section in the panel or in the menu of a phone. A section the status of the site closes
 * keeps its place and its label, but is not a link: the lock, not the colour, says so.
 */
function SectionLink({
  site,
  entry,
  active,
  onPick,
}: {
  site: ShellSite
  entry: SiteNavEntry
  active: boolean
  onPick?: () => void
}) {
  const open = siteSectionAvailable(site.status, entry.section, site.setup)
  const look = {
    display: 'flex',
    alignItems: 'center',
    gap: 1.5,
    minHeight: 44,
    px: 1.5,
    borderRadius: '10px',
    fontSize: 14,
  } as const
  if (!open) {
    return (
      <Box
        component="span"
        aria-disabled="true"
        aria-describedby={CLOSED_NOTE}
        sx={{ ...look, color: 'text.secondary', cursor: 'not-allowed' }}
      >
        <AppIcon name={entry.icon} size={20} />
        <Box component="span" sx={{ flex: '1 1 auto' }}>
          {entry.label}
          <Box component="span" sx={visuallyHidden}>
            {CLOSED_SUFFIX}
          </Box>
        </Box>
        <AppIcon name="lock" size={16} />
      </Box>
    )
  }
  return (
    <Box
      component={Link}
      href={siteHref(site.id, entry.section)}
      aria-current={active ? 'page' : undefined}
      onClick={onPick}
      sx={{
        ...look,
        textDecoration: 'none',
        color: active ? 'text.primary' : 'text.secondary',
        fontWeight: active ? 600 : 500,
        bgcolor: active ? 'action.selected' : 'transparent',
        '&:hover': { bgcolor: active ? 'action.selected' : 'action.hover', color: 'text.primary' },
        '& svg': { color: active ? 'primary.main' : 'inherit' },
      }}
    >
      <AppIcon name={entry.icon} size={20} />
      {entry.label}
    </Box>
  )
}

/** The sections of the site as a list: in the panel and in the menu of a phone. */
function SectionList({
  site,
  active,
  onPick,
}: {
  site: ShellSite
  active: SiteNavEntry['section'] | undefined
  onPick?: () => void
}) {
  return (
    <Box
      component="ul"
      sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 0.25 }}
    >
      {siteNav.map((entry) => (
        <li key={entry.section}>
          <SectionLink
            site={site}
            entry={entry}
            active={entry.section === active}
            {...(onPick ? { onPick } : {})}
          />
        </li>
      ))}
    </Box>
  )
}

/** The card of the site on top of its panel: its mark, name, address and status (Н10). */
function SiteCard({ site }: { site: ShellSite }) {
  // The first character whole: a name may start with one that takes two UTF-16 units.
  const mark = Array.from(site.name.trim())[0]?.toLocaleLowerCase('ru') || '•'
  const status = statusLabels[site.status as keyof typeof statusLabels]
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        p: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: '14px',
        bgcolor: 'background.default',
      }}
    >
      <SiteMark siteId={site.id} name={site.name} mark={mark} />
      <Box sx={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Typography
          component="span"
          sx={{
            fontWeight: 600,
            fontSize: 15,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {site.name}
        </Typography>
        <Typography
          component="span"
          variant="caption"
          color="text.secondary"
          sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {hostOf(site.url)}
        </Typography>
        {status ? (
          <Typography
            component="span"
            variant="caption"
            color="text.secondary"
            sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.25 }}
          >
            <Box
              component="span"
              aria-hidden="true"
              sx={{
                width: 7,
                height: 7,
                flex: 'none',
                borderRadius: '50%',
                bgcolor: statusDot[site.status] ?? statusDotColors.off,
              }}
            />
            {status}
          </Typography>
        ) : null}
      </Box>
    </Box>
  )
}

/** The panel of the site from `md` (Н2): the way to all projects, its card, sections and actions. */
function SitePanel({
  site,
  active,
}: {
  site: ShellSite
  active: SiteNavEntry['section'] | undefined
}) {
  return (
    <CabinetPanel label="Разделы сайта">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 60, pl: 1, pr: 1.25 }}>
        <Box
          component={Link}
          href="/projects"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            minHeight: 36,
            pl: 0.5,
            pr: 1.25,
            borderRadius: '10px',
            color: 'text.secondary',
            fontSize: 14,
            textDecoration: 'none',
            '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
          }}
        >
          <AppIcon name="back" size={18} />
          Все проекты
        </Box>
        <Box sx={{ flex: '1 1 auto' }} />
        <PanelToggle place="panel" />
      </Box>
      <Box sx={{ px: 1.5, pb: 1.5 }}>
        <SiteCard site={site} />
      </Box>
      <Box component="nav" aria-label="Разделы сайта" sx={{ px: 1 }}>
        <SectionList site={site} active={active} />
      </Box>
      <Box
        sx={{
          mt: 'auto',
          p: 1.5,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.5,
          borderTop: 1,
          borderColor: 'divider',
        }}
      >
        <NewChatLink site={site} />
        <OpenSite site={site} />
      </Box>
    </CabinetPanel>
  )
}

/** «Чат в этом проекте», when the server takes a new chat of the project now (Н10). */
function NewChatLink({ site, onPick }: { site: ShellSite; onPick?: () => void }) {
  if (!takesNewChat(site)) return null
  return (
    <ButtonBase
      component={Link}
      href={newChatHref(site.id)}
      onClick={onPick}
      sx={{
        gap: 1,
        minHeight: 40,
        border: 1,
        borderColor: 'divider',
        borderRadius: '10px',
        fontSize: 14,
        fontWeight: 500,
        color: 'text.primary',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      <AppIcon name="plus" size={18} />
      Чат в этом проекте
    </ButtonBase>
  )
}

function OpenSite({ site }: { site: ShellSite }) {
  return (
    <Box
      component="a"
      href={site.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Открыть сайт ${site.name} в новой вкладке`}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.75,
        minHeight: 40,
        fontSize: 13.5,
        color: 'text.secondary',
        textDecoration: 'none',
        '&:hover': { color: 'text.primary', textDecoration: 'underline' },
      }}
    >
      Открыть сайт
      <AppIcon name="arrow" size={15} />
    </Box>
  )
}

/**
 * Below `md` the panel is not beside the content (Н7): a button in the bar names the section and
 * opens the sections in a drawer from the left.
 */
function SectionMenu({
  site,
  active,
}: {
  site: ShellSite
  active: SiteNavEntry['section'] | undefined
}) {
  const current = siteNav.find((entry) => entry.section === active)?.label ?? 'Разделы'
  return (
    <PanelDrawer label="Разделы сайта" current={current}>
      {(close) => (
        <>
          <Box
            component={Link}
            href="/projects"
            onClick={close}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.5,
              minHeight: 44,
              color: 'text.secondary',
              fontSize: 14,
              textDecoration: 'none',
            }}
          >
            <AppIcon name="back" size={18} />
            Все проекты
          </Box>
          <SiteCard site={site} />
          <Box component="nav" aria-label="Разделы сайта">
            <SectionList site={site} active={active} onPick={close} />
          </Box>
          <Box sx={{ mt: 'auto', display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <NewChatLink site={site} onPick={close} />
            <OpenSite site={site} />
          </Box>
        </>
      )}
    </PanelDrawer>
  )
}

/**
 * The page of one site (docs/plan/64-cabinet-navigation.md, Н2, Н7, Н10): the rail of the cabinet,
 * the panel of the site beside it, breadcrumbs that lead back to the projects over the content.
 *
 * While the site is being set up the page is the setup screen alone: no panel and no sections —
 * the breadcrumbs are the way back to the projects.
 */
export function SiteShell({
  user,
  site,
  panelState = 'open',
  panelWidth = null,
  children,
}: {
  user: ApplicationUser
  site: ShellSite
  /** The state of the panel beside the rail, from its cookie. */
  panelState?: CabinetPanelState
  /** The width the viewer dragged the panel to, from its cookie; null — the default. */
  panelWidth?: number | null
  children: ReactNode
}) {
  const pathname = usePathname()
  const active = activeSiteSection(pathname, site.id)
  // Set while the status of the site leaves «Обзор» alone open.
  const closedNote = closedSectionsNote(site.status)
  const setup = inSiteSetup(site.setup)
  const section = siteNav.find((entry) => entry.section === active)
  const crumbs = [
    { label: 'Проекты', href: '/projects' },
    ...(setup || !section
      ? [{ label: site.name }]
      : [{ label: site.name, href: siteHref(site.id, 'overview') }, { label: section.label }]),
  ]
  return (
    <CabinetShell
      user={user}
      panel={setup ? undefined : <SitePanel site={site} active={active} />}
      panelState={panelState}
      panelWidth={panelWidth}
      skipTarget="site-content"
    >
      {closedNote ? (
        <span id={CLOSED_NOTE} hidden>
          {closedNote}
        </span>
      ) : null}
      <ApplicationToolbar
        label="Панель сайта"
        crumbs={crumbs}
        // While the site is being set up there is no panel: the site opens from the bar.
        end={
          setup ? (
            <Box sx={{ ml: 'auto' }}>
              <OpenSite site={site} />
            </Box>
          ) : undefined
        }
        start={
          setup ? undefined : (
            <>
              <SectionMenu site={site} active={active} />
              <Box sx={{ display: { xs: 'none', md: 'flex' }, mr: 1, ml: -1 }}>
                <PanelToggle place="content" />
              </Box>
            </>
          )
        }
        sx={{
          minHeight: { xs: 56, md: 60 },
          px: SIDE_PADDING,
          gap: '4px 0',
          flexWrap: 'wrap',
          '& .MuiBreadcrumbs-root': {
            minWidth: 0,
            display: { xs: setup ? 'block' : 'none', md: 'block' },
          },
        }}
      />
      <Box
        component="main"
        id="site-content"
        tabIndex={-1}
        sx={{
          flex: '1 0 auto',
          display: 'flex',
          flexDirection: 'column',
          px: SIDE_PADDING,
          py: { xs: 3, md: 3.5 },
          minWidth: 0,
          outline: 'none',
        }}
      >
        {children}
      </Box>
    </CabinetShell>
  )
}
