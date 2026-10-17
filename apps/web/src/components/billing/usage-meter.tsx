import Box from '@mui/material/Box'
import type { Theme } from '@mui/material/styles'

import { paletteOf } from './billing-surface'

/**
 * What a part of a meter stands for. A fill is never the only way to tell the parts apart:
 * every meter has an accessible name with its numbers, and the legend names each part.
 */
export type MeterTone = 'spent' | 'expired' | 'held' | 'left' | 'out'

/** The fill of each tone, from the roles of the theme: it follows the colour scheme. */
function fillOf(theme: Theme, tone: MeterTone): string {
  const palette = paletteOf(theme)
  switch (tone) {
    case 'spent':
      return palette.primary.main
    case 'expired':
      // Gone without a charge: neither spent nor left.
      return palette.text.disabled
    case 'held':
      return 'var(--raditi-accent)'
    case 'left':
      return `color-mix(in srgb, var(--raditi-accent) 16%, ${palette.background.paper})`
    case 'out':
      return palette.error.main
  }
}

/** The line around a track and a swatch: a pale fill is still seen against the surface. */
const outlined = (theme: Theme) => ({ boxShadow: `0 0 0 1px ${paletteOf(theme).text.secondary}` })

export interface MeterPart {
  tone: MeterTone
  value: number
}

/**
 * A track divided in proportion to its parts; a part of zero is not drawn. One image for
 * assistive technology: `label` says in words everything the fills show. `total`: what the
 * whole track stands for, when the parts may come to less — the rest of it stays empty.
 */
export function Meter({
  label,
  parts,
  height,
  total,
}: {
  label: string
  parts: readonly MeterPart[]
  height: number
  total?: number
}) {
  const rest = total === undefined ? 0 : total - parts.reduce((sum, { value }) => sum + value, 0)
  return (
    <Box
      role="img"
      aria-label={label}
      sx={(theme) => ({
        display: 'flex',
        gap: '2px',
        height,
        overflow: 'hidden',
        borderRadius: '4px', // impeccable-disable-line design-system-radius: the track of a meter
        bgcolor: 'background.paper',
        ...outlined(theme),
      })}
    >
      {parts
        .filter(({ value }) => value > 0)
        .map(({ tone, value }) => (
          <Box
            component="span"
            key={tone}
            data-tone={tone}
            // The smallest part stays wide enough to be seen.
            sx={(theme) => ({ flex: `${value} 1 0`, minWidth: 6, bgcolor: fillOf(theme, tone) })}
          />
        ))}
      {rest > 0 ? <Box component="span" data-rest="" sx={{ flex: `${rest} 1 0` }} /> : null}
    </Box>
  )
}

/** The square of a legend entry, filled as its part of the meter. */
export function Swatch({ tone }: { tone: MeterTone }) {
  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={(theme) => ({
        display: 'inline-block',
        flexShrink: 0,
        width: 10,
        height: 10,
        borderRadius: '2px', // impeccable-disable-line design-system-radius: the square of a legend entry
        bgcolor: fillOf(theme, tone),
        ...outlined(theme),
      })}
    />
  )
}

/** A bar of the per-site chart: `share` of the widest one, from 0 to 1. */
export function Bar({ share }: { share: number }) {
  return (
    <Box component="span" aria-hidden="true" sx={{ display: 'block' }}>
      <Box
        component="span"
        sx={(theme) => ({
          display: 'block',
          width: `${Math.max(share, 0) * 100}%`,
          // A credit or two beside a busy site is still a bar, not a hairline.
          minWidth: 6,
          height: 8,
          borderRadius: '0 4px 4px 0', // impeccable-disable-line design-system-radius: the end of a chart bar
          bgcolor: fillOf(theme, 'spent'),
        })}
      />
    </Box>
  )
}
