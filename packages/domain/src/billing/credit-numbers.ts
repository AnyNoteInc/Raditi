import { badRequest } from '../errors.ts'

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

/**
 * A new task is taken while at least this many credits can be spent on it — one: nothing but
 * credits bounds a task, and a pass is charged what its work took, rounded up, with no minimum
 * (owner's decision of 10.11.2026, docs/spec.md §20, «Только кредиты», КР5–КР8). A pass may
 * spend more than the balance; what it could not pay is the workspace's debt, which the next
 * grant pays first.
 */
export const minStartCredits = 1

/**
 * The reserve of an attempt: one credit. It says that a task is in work — the chain of its
 * attempts and the day are told by reserve rows —, not how much it may spend: a pass spends what
 * the customer has, and its charge is not bounded by the reserve.
 */
export const attemptReserveCredits = 1

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
  small: typical(5, 5),
  block: typical(15, 25),
  large: typical(25, 40),
} as const satisfies Record<string, TypicalCredits>)
export type TypicalTask = keyof typeof typicalTaskCredits

/**
 * How many times the price of the pack a customer pays whose tariff does not take tasks — none,
 * overdue or ended (owner's decision of 10.11.2026, docs/spec.md §20, «Только кредиты», КР9):
 * the pack is sold to them too, at twice the price of the pack on top of a tariff.
 */
export const packWithoutTariffPriceFactor = 2

/**
 * The gift of the registration: credits a user is given once, to try the service before a
 * tariff — 50 since the pricing of 06.11.2026 (docs/plan/63-new-pricing.md, Ц5; 35 before).
 * About five average tasks. A change of the number does not touch gifts already granted: each
 * stands in the ledger with the amount of its day.
 */
export const signupGiftCredits = 50

function assertCredits(credits: number): void {
  if (!Number.isSafeInteger(credits) || credits < 0) throw badRequest('Invalid count of credits')
}

/**
 * How many average tasks a number of credits holds, for a sentence that says «в среднем около»:
 * credits ÷ `averageTaskCredits`, rounded half up to a whole task and, from a hundred tasks up,
 * to the nearest ten — the tariffs of 06.11.2026 150 → 14, 600 → 55, 2 000 → 180, the pack
 * 100 → 9. A promise, not arithmetic of the ledger: the charge of a task comes from the work it
 * took.
 *
 * Rounded to the nearest, the count can stand a little above what the credits hold: 14 average
 * tasks are 154 credits, 55 are 605, and the calculator of the landing adds a pack at such a
 * count. Known and kept as the default of the design
 * (docs/research/2026-10-credits/credits-design.md, §10, item 13); rounding down — 13, 54, 180,
 * 9 — is the owner's to choose.
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
 * What a number of gift credits is enough for, for the sentence «их хватит на десять небольших
 * правок или на три-пять задач побольше»: 50 → 10 small edits, 3–5 larger tasks. Small edits at
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
