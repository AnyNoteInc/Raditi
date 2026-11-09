import { keyframes } from '@mui/material/styles'

// The motion of a dialog: a row that arrives fades in; the agent at work is the moving mark of
// Raditi (`BrandProgress`). Nothing else moves, and nothing moves for a viewer who asked for less.

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
