// What each stack gives the stand of the site stacks (verify-stack.mjs; docs/plan/62-slices/e3.md,
// Э3.10): its builds, the install of a production and what the scenarios check. Э4 and Э5 add a
// file of their own and a row here; the closed CMS of plan 62 never has one.
import { joomlaStand } from './joomla.mjs'

export const STACK_STANDS = Object.freeze({ joomla: joomlaStand })
