'use client'

import Box from '@mui/material/Box'

import { fontFamilies } from '../theme/tokens.ts'
import { BrandSymbol } from './brand-symbol.tsx'

export type BrandMarkProps = {
  /** Diameter of the circular mark, px. */
  size?: number
  /** Show the «Радити» wordmark next to the mark. */
  withWordmark?: boolean
}

/** The brand symbol keeps its amber and ink colours in both themes. */
export function BrandMark({ size = 32, withWordmark = true }: BrandMarkProps) {
  return (
    <Box
      component="span"
      role="img"
      aria-label="Радити"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: `${Math.round(size * 0.3)}px`,
        color: 'text.primary',
        verticalAlign: 'middle',
      }}
    >
      <BrandSymbol size={size} />
      {withWordmark ? (
        <Box
          component="span"
          aria-hidden="true"
          sx={{
            fontFamily: fontFamilies.heading,
            fontWeight: 700,
            fontSize: `${Math.round(size * 0.5625)}px`,
            letterSpacing: '-0.02em',
            lineHeight: 1,
          }}
        >
          Радити
        </Box>
      ) : null}
    </Box>
  )
}
