'use client'

import Box from '@mui/material/Box'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

// The tabs of the third layer of a section (docs/plan/64-cabinet-navigation.md, Н5, Н6): each a
// page of its own. Kept from the sections of a project, which went with projects
// (docs/plan/83-remove-projects.md, БП1), for «Запланированные задачи» (docs/plan/82, Зп2).

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
