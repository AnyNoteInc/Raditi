// The numbers of the landing motion that a script needs. The times and distances of what CSS
// animates are variables on `.page` and have no copy here; the phases of the demo have no copy
// in CSS, the demo hands them over as a variable of its stage.

/** How long each busy phase of the demo is shown: a pause to read the status, not an animation. */
export const PHASE_MS = { preparing: 650, applying: 700 } as const
