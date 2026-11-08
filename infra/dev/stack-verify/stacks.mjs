// What each stack gives the stand of the site stacks (verify-stack.mjs; docs/plan/62-slices/e3.md,
// Э3.10): its builds, the install of a production and what the scenarios check. Э4 and Э5 add a
// file of their own and a row here; the closed CMS of plan 62 never has one. WordPress (Э3.15) is
// the stack on which everything already works: a group that fails on it is the stand's fault.
import { joomlaStand } from './joomla.mjs'
import { wordpressStand } from './wordpress.mjs'

export const STACK_STANDS = Object.freeze({ joomla: joomlaStand, wordpress: wordpressStand })
