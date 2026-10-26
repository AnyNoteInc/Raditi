'use client'

import Button from '@mui/material/Button'
import MuiLink from '@mui/material/Link'
import Link from 'next/link'
import type { ReactNode } from 'react'

/** A link of the site page in the colours of the theme; the pages that use it render on the server. */
export function SiteLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <MuiLink component={Link} href={href} sx={{ textUnderlineOffset: 3 }}>
      {children}
    </MuiLink>
  )
}

/** A link drawn as an outlined button of the theme. */
export function SiteButtonLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button
      component={Link}
      href={href}
      variant="outlined"
      sx={{ alignSelf: 'flex-start', minHeight: 44, borderRadius: '999px' }}
    >
      {children}
    </Button>
  )
}
