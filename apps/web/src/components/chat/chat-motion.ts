import { keyframes } from '@mui/material/styles'

// The motion of a dialog: a row that arrives fades in; the agent at work is the moving mark of
// Raditi (`BrandProgress`), and the item of its plan it works on now breathes (docs/plan/89, §6.1).
// Nothing else moves, and nothing moves for a viewer who asked for less.

/** A row that has just arrived: up a few pixels from nothing. */
const rise = keyframes`
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
`

const reduced = '@media (prefers-reduced-motion: reduce)'

/** A row, a step or an opened block that appears in answer to something. */
export const riseIn = {
  animation: `${rise} 220ms var(--raditi-ease-out) both`,
  [reduced]: { animation: 'none' },
} as const

const breathe = keyframes`
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.8); }
`

/** The mark of the item the agent works on now: a slow pulse of 1.6 s, still for less motion. */
export const atWorkPulse = {
  animation: `${breathe} 1.6s ease-in-out infinite`,
  [reduced]: { animation: 'none' },
} as const
