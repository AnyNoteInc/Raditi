import { badRequest } from '../errors.ts'
import type { ModelClass } from '../llm/model-class.ts'

// The customer's side of the credits model in numbers (docs/plan/37-billing-plan.md, «Числа»):
// what a task costs at least, on average and typically, how much one attempt may set aside, how
// many credits a new task needs to start and the gift of the registration.
// They are defaults of the design, in force until the owner says otherwise, and estimates until
// the reference basket is measured on the model that runs (the gate before live payments) — so
// each number is written here once and every page, letter and rule takes it from here.
//
// The numbers do not move with the rates of a model: the credit rate follows the basket, and
// what the customer is promised stays. The credits of the tariffs, of their days and of the pack
// are not here: they are plan terms, rows of `plans`.
//
// The module imports nothing that runs but the error of the domain: the pages of the browser
// take it by its own path, `@repo/domain/billing/credit-numbers`, without the rest of the
// package. `credits.ts` exports the same names for everything else.

/** A done task is charged at least this many credits, however little work it took. */
export const minTaskChargeCredits = 5

/**
 * A new task is taken only while this many credits can be spent on it: the minimum charge, so a
 * done task can always be charged it — and the number the customer already knows as the price
 * of a small edit.
 */
export const minStartCredits = minTaskChargeCredits

/**
 * What a done task is charged on average, rounded up to a whole credit: 10.76 over the mix of
 * small edits, blocks and big tasks. Every promise of a count of tasks divides by it; no kind
 * of task costs the average, so the texts say «в среднем».
 */
export const averageTaskCredits = 11

/** «5», «15–25»: what a kind of request usually costs, in credits; one figure has `from` = `to`. */
export interface TypicalCredits {
  readonly from: number
  readonly to: number
}

const typical = (from: number, to: number): TypicalCredits => Object.freeze({ from, to })

/**
 * The orientation list — the customer's way to tell what a request will cost before it is done:
 * - `small`: «поменять текст, цену, телефон или фото»;
 * - `block`: «добавить блок, баннер или страницу, поправить оформление»;
 * - `large`: «большая задача: несколько страниц, новая форма, сложная логика».
 */
export const typicalTaskCredits = Object.freeze({
  small: typical(minTaskChargeCredits, minTaskChargeCredits),
  block: typical(15, 25),
  large: typical(25, 40),
} as const satisfies Record<string, TypicalCredits>)
export type TypicalTask = keyof typeof typicalTaskCredits

/**
 * The step of an attempt: the most one attempt of a task sets aside, by the class of its model.
 * A task that needs more asks the customer whether to go on. At the provisional credit rate of
 * 6.00 RUB these are 120, 270 and 720 RUB of accounting cost — inside the ceilings of an
 * attempt, `quotaAttemptCeilingsRub`.
 */
export const attemptStepCredits = Object.freeze({
  light: 20,
  standard: 45,
  heavy: 120,
} as const satisfies Record<ModelClass, number>)

/**
 * The gift of the registration: credits a user is given once, to try the service before a
 * tariff. About three average tasks. A change of the number does not touch gifts already
 * granted: each stands in the ledger with the amount of its day.
 */
export const signupGiftCredits = 35

function assertCredits(credits: number): void {
  if (!Number.isSafeInteger(credits) || credits < 0) throw badRequest('Invalid count of credits')
}

/**
 * How many average tasks a number of credits holds, for a sentence that says «в среднем около»:
 * credits ÷ `averageTaskCredits`, rounded half up to a whole task and, from a hundred tasks up,
 * to the nearest ten — 300 → 27, 800 → 73, 2 500 → 230, 100 → 9. A promise, not arithmetic of
 * the ledger: the charge of a task comes from the work it took.
 *
 * Rounded to the nearest, the count can stand a little above what the credits hold: 230 average
 * tasks are 2 530 credits, and the calculator of the landing adds a pack at that count. Known
 * and kept as the default of the design (docs/research/2026-10-credits/credits-design.md, §10,
 * item 13); rounding down — 27, 72, 220, 9 — is the owner's to choose.
 */
export function averageTaskCount(credits: number): number {
  assertCredits(credits)
  // In whole numbers, and each time from the exact quotient: a count rounded to a whole task
  // and then to a ten would round twice.
  const roundedTo = (unit: number) => {
    const divisor = averageTaskCredits * unit
    return Math.floor((2 * credits + divisor) / (2 * divisor)) * unit
  }
  const tasks = roundedTo(1)
  return tasks < 100 ? tasks : roundedTo(10)
}

/** What a number of gift credits is enough for, as `giftTaskCounts` counts it. */
export interface GiftTaskCounts {
  /** Small edits, each at its usual charge. */
  readonly small: number
  /** Larger tasks: `from` blocks at the bottom of their range, `to` tasks of the average charge. */
  readonly larger: { readonly from: number; readonly to: number }
}

/**
 * What a number of gift credits is enough for, for the sentence «их хватит на семь небольших
 * правок или на две-три задачи побольше»: 35 → 7 small edits, 2–3 larger tasks. Small edits at
 * their usual charge, rounded down; larger tasks from blocks at the bottom of their range,
 * rounded down, to tasks of the average charge (`averageTaskCount`). A promise, like every
 * count of tasks: the charge of a task comes from the work it took.
 */
export function giftTaskCounts(credits: number): GiftTaskCounts {
  assertCredits(credits)
  return {
    small: Math.floor(credits / typicalTaskCredits.small.to),
    larger: {
      from: Math.floor(credits / typicalTaskCredits.block.from),
      to: averageTaskCount(credits),
    },
  }
}
