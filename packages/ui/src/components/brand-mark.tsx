'use client'
// A client component: the `sx` callback below cannot cross the server/client boundary.

import Box from '@mui/material/Box'
import { keyframes } from '@mui/material/styles'

import { brandColors, fontFamilies } from '../theme/tokens.ts'

const blink = keyframes`
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
`

export type BrandMarkProps = {
  /** Size of the square mark, px. */
  size?: number
  /** Show the «Радити» wordmark next to the mark. */
  withWordmark?: boolean
  /** Blinking caret as in the landing header; it stays still for reduced motion. */
  animated?: boolean
}

/** Ink tile with a marker caret; the colours swap in the dark scheme, as in the landing footer. */
export function BrandMark({ size = 32, withWordmark = true, animated = false }: BrandMarkProps) {
  return (
    <Box
      component="span"
      role="img"
      aria-label="Радити"
      sx={(theme) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: `${Math.round(size * 0.3)}px`,
        color: 'text.primary',
        verticalAlign: 'middle',
        '& .brand-mark-tile': { fill: brandColors.ink },
        '& .brand-mark-caret': {
          fill: brandColors.marker,
          animation: animated ? `${blink} 1.1s infinite` : 'none',
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        },
        ...theme.applyStyles('dark', {
          '& .brand-mark-tile': { fill: brandColors.marker },
          '& .brand-mark-caret': { fill: brandColors.ink },
        }),
      })}
    >
      <svg
        viewBox="0 0 32 32"
        width={size}
        height={size}
        aria-hidden="true"
        focusable="false"
        style={{ flex: 'none', display: 'block' }}
      >
        <rect className="brand-mark-tile" width="32" height="32" rx="9" />
        <rect className="brand-mark-caret" x="14.5" y="8" width="3" height="16" rx="1.5" />
      </svg>
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
