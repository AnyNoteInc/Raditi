'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

import { AppIcon } from '@/components/application/app-icon'

// A section of a site page (docs/plan/64-cabinet-navigation.md, Н5, Н6): its name, and under it
// the tabs of the third layer — each a page of its own.

/**
 * One tab of a section. It is the current one while the page under the section's root is one of
 * its `segments` (`''` — the root itself), or any other segment with `rest`.
 */
export interface SectionTab {
  label: string
  href: string
  segments?: readonly string[]
  /** Every segment no other tab names: the pages of the items of a list. */
  rest?: boolean
}

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

function currentTab(
  tabs: readonly SectionTab[],
  root: string,
  pathname: string,
): SectionTab | undefined {
  const segment = pathname.slice(root.length).replace(/^\/+/, '').split('/')[0] ?? ''
  return (
    tabs.find((tab) => tab.segments?.includes(segment)) ??
    tabs.find((tab) => tab.rest && segment !== '')
  )
}

export function SectionTabs({
  label,
  root,
  tabs,
}: {
  label: string
  /** The address of the section: the segments of the tabs are read under it. */
  root: string
  tabs: readonly SectionTab[]
}) {
  const pathname = usePathname()
  // The id in the address may be spelled in any case: the root is matched without regard to it.
  const path = pathname.toLowerCase().startsWith(root.toLowerCase())
    ? root + pathname.slice(root.length)
    : pathname
  const current = currentTab(tabs, root, path)
  return (
    <Box
      component="nav"
      aria-label={label}
      sx={{
        display: 'flex',
        gap: 0.5,
        overflowX: 'auto',
        borderBottom: 1,
        borderColor: 'divider',
        // The tabs scroll sideways on a phone, the bar does not.
        scrollbarWidth: 'none',
      }}
    >
      {tabs.map((tab) => {
        const on = tab === current
        return (
          <Box
            key={tab.href}
            component={Link}
            href={tab.href}
            aria-current={on ? 'page' : undefined}
            sx={{
              position: 'relative',
              flex: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 44,
              px: 1.75,
              borderRadius: '8px 8px 0 0',
              fontSize: 14,
              fontWeight: on ? 600 : 500,
              color: on ? 'text.primary' : 'text.secondary',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
              '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
              '&::after': {
                content: '""',
                position: 'absolute',
                left: 10,
                right: 10,
                bottom: -1,
                height: 2,
                borderRadius: 2,
                bgcolor: on ? 'primary.main' : 'transparent',
              },
            }}
          >
            {tab.label}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * The content of one tab: a block's own heading (`SectionTitle` of level `h2`) stays in the outline
 * but not on the screen — the tab already names it. The page of an item of a list (a version, a
 * run) is not a tab: its heading stays.
 */
export function TabContent({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        '& [data-section-title="h2"]': visuallyHidden,
      }}
    >
      {children}
    </Box>
  )
}

/** A section page: the heading, an action beside it, the tabs when it has them, the content. */
export function SiteSection({
  title,
  root,
  tabs,
  action,
  children,
}: {
  title: string
  root: string
  tabs?: readonly SectionTab[]
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, maxWidth: 1180 }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <Typography
            component="h1"
            sx={{
              flex: '1 1 auto',
              fontSize: { xs: 26, md: 30 },
              fontWeight: 600,
              lineHeight: 1.25,
            }}
          >
            {title}
          </Typography>
          {action}
        </Box>
        {tabs && tabs.length > 1 ? <SectionTabs label={title} root={root} tabs={tabs} /> : null}
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>{children}</Box>
    </Box>
  )
}

/** The way from an item of a list back to the list: «← Все версии». */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Box
      component={Link}
      href={href}
      sx={{
        alignSelf: 'flex-start',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        minHeight: 44,
        mt: -1,
        pr: 1,
        color: 'text.secondary',
        fontSize: 14,
        textDecoration: 'none',
        '&:hover': { color: 'text.primary', textDecoration: 'underline' },
      }}
    >
      <AppIcon name="back" size={20} />
      {children}
    </Box>
  )
}
