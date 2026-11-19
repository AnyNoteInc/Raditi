// A stand-in for the server: it takes batches, checks the limits of plan 88 §7.2 and answers
// with totals counted in decimal.js (rule 9: money is never a binary float). In the product this
// is `artifact.apply` and `applyArtifactOps`; here it only keeps the spike honest about the cost.
import { Decimal } from 'decimal.js'
import type { PriceRow } from '../table/model'
import { LIMITS } from '../table/model'
import type { Batch } from '../table/store'

const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })
const encoder = new TextEncoder()

export interface Totals {
  rows: number
  inStock: number
  priced: number
  sum: string
  average: string
  computedMs: number
}

export function computeTotals(rows: Iterable<PriceRow>): Totals {
  const t0 = performance.now()
  let count = 0
  let inStock = 0
  let priced = 0
  let sum = new Money(0)
  for (const row of rows) {
    count++
    if (row.inStock) inStock++
    if (row.price !== '') {
      priced++
      sum = sum.plus(row.price)
    }
  }
  const average = priced === 0 ? '' : sum.div(priced).toDecimalPlaces(2).toFixed(2)
  return { rows: count, inStock, priced, sum: sum.toFixed(2), average, computedMs: performance.now() - t0 }
}

export type Refusal = { opId: string; code: 'LIMIT' | 'TOO_LARGE'; detail: string }

export interface ServerStub {
  accept(batch: Batch): void
  readonly refusals: Refusal[]
  readonly accepted: number
}

/** Accepts batches asynchronously, like a request; after a quiet moment, recounts the totals. */
export function createServerStub(readRows: () => Iterable<PriceRow>, onTotals: (t: Totals) => void): ServerStub {
  const refusals: Refusal[] = []
  let accepted = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const recount = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => onTotals(computeTotals(readRows())), 30)
  }
  recount()
  return {
    refusals,
    get accepted() {
      return accepted
    },
    accept(batch) {
      setTimeout(() => {
        const bytes = encoder.encode(JSON.stringify(batch)).length
        if (batch.ops.length > LIMITS.opsPerBatch) {
          refusals.push({ opId: batch.opId, code: 'LIMIT', detail: `${batch.ops.length} operations` })
          return
        }
        if (bytes > LIMITS.batchBytes) {
          refusals.push({ opId: batch.opId, code: 'TOO_LARGE', detail: `${bytes} bytes` })
          return
        }
        accepted++
        recount()
      }, 0)
    },
  }
}
