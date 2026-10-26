import { keyframes } from '@mui/material/styles'

// The motion of a dialog: a row that arrives fades in, and a dot pulses while the agent works.
// Nothing else moves, and nothing moves for a viewer who asked for less motion.

/** A row that has just arrived: up a few pixels from nothing. */
const rise = keyframes`
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
`

/** The dot of the agent at work. */
const pulse = keyframes`
  0%, 100% { transform: scale(0.75); opacity: 0.5; }
  50% { transform: scale(1); opacity: 1; }
`

const reduced = '@media (prefers-reduced-motion: reduce)'

/** A row, a step or an opened block that appears in answer to something. */
export const riseIn = {
  animation: `${rise} 220ms var(--raditi-ease-out) both`,
  [reduced]: { animation: 'none' },
} as const

/** The dot of the agent at work. */
export const pulsing = {
  animation: `${pulse} 1.4s var(--raditi-ease-in-out) infinite`,
  [reduced]: { animation: 'none' },
} as const
