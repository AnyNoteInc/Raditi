import type { ReactNode } from 'react'

import { BrandMark, Link, Stack, Typography } from '../../components/index.ts'

export type AuthHeaderProps = {
  title: string
  subtitle?: ReactNode
  homeHref?: string
}

export function AuthHeader({ title, subtitle, homeHref = '/' }: AuthHeaderProps) {
  return (
    <Stack spacing={2} sx={{ alignItems: 'center', textAlign: 'center' }}>
      <Link
        href={homeHref}
        aria-label="Радити — на главную"
        underline="none"
        sx={{ display: 'inline-flex', color: 'inherit' }}
      >
        <BrandMark size={36} />
      </Link>
      <Typography component="h1" variant="h4">
        {title}
      </Typography>
      {subtitle ? (
        <Typography variant="body2" color="text.secondary">
          {subtitle}
        </Typography>
      ) : null}
    </Stack>
  )
}
