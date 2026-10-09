import { motionTokens } from '@repo/ui/theme/tokens'

// The numbers of the landing motion that a script needs. CSS holds the same values as variables
// on `.page`, and css-modules.test.ts keeps the two in step; the phases of the demo have no copy
// in CSS at all, the demo hands them over as a variable of its stage.

/** The curve of an entrance, as the Web Animations API takes it. */
export const EASE_OUT = motionTokens.easeOut

/** `--motion-move`: an object moves — the heading of a section rises into the window. */
export const MOVE_MS = 560

/** `--motion-rise`: how far it rises, in px. */
export const RISE_PX = 24

/** How long each busy phase of the demo is shown: a pause to read the status, not an animation. */
export const PHASE_MS = { preparing: 650, applying: 700 } as const
