import {
  chargeRenewals,
  endPeriods,
  renewalJobs,
  sendRenewalNotices,
  settleStuckOrders,
  type RenewalDeps,
  type RenewalFailureReport,
  type RenewalJob,
  type RenewalPass,
} from '@repo/billing'
import type { PrismaClient } from '@repo/db'
import type { QueueName } from '@repo/domain'
import { errorMessage } from '@repo/observability'

import type { BillingConfig } from '../config/config.ts'

/** The queue of the renewal passes; job name = the pass. */
export const BILLING_QUEUE = 'billing' satisfies QueueName

export function isRenewalJob(name: string): name is RenewalJob {
  return (renewalJobs as readonly string[]).includes(name)
}

export interface BillingJobsOptions {
  prisma: PrismaClient
  /** null while payments are off: the passes then charge nobody (CoreConfig.yookassa). */
  yookassa: RenewalDeps['yookassa']
  config: BillingConfig
  /** Counts rows by how they ended; no identifiers. */
  count?: (job: RenewalJob, outcome: string, rows: number) => void
  logger: { log(line: string): void; warn(line: string): void }
  /** The clock of the passes; the system one unless given. */
  now?: () => Date
}

/** `notified=2 skipped=1`: the ways the rows of a pass ended, without the ones nothing ended in. */
function summary(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .filter(([, rows]) => rows > 0)
    .map(([outcome, rows]) => `${outcome}=${rows}`)
    .join(' ')
}

/**
 * Runs the renewal passes of @repo/billing for the scheduler: gives them the database, the
 * shop and the settings of this process, and turns what they return into log lines and
 * counts. Everything that decides about money is in the passes; a pass may be run by any
 * number of processes at once.
 */
export class BillingJobs {
  readonly #options: BillingJobsOptions

  constructor(options: BillingJobsOptions) {
    this.#options = options
  }

  /**
   * One pass. `signal` is aborted on shutdown: the pass ends after the row it is at. Rejects
   * for an unknown name and when the pass itself could not run — the database is away; a row
   * that failed is logged and counted, and the pass goes on.
   */
  async run(job: string, signal?: AbortSignal): Promise<void> {
    if (!isRenewalJob(job)) throw new Error(`Unknown billing job "${job}"`)
    const { prisma, yookassa, config, logger, now } = this.#options
    const deps: RenewalDeps = {
      prisma,
      yookassa,
      appUrl: config.appUrl,
      settings: { noticeDays: config.renewalNoticeDays, pastDueDays: config.pastDueDays },
      onError: (report) => logger.warn(failureLine(report)),
      ...(now === undefined ? {} : { now }),
      ...(signal === undefined ? {} : { signal }),
    }
    const pass = await this.#pass(job, deps)
    for (const [outcome, rows] of Object.entries(pass.counts)) {
      if (rows > 0) this.#options.count?.(job, outcome, rows)
    }
    // A row another pass was at, or one that was not due any more, is nothing to report.
    const { skipped: _skipped, ...moved } = pass.counts
    const done = summary(moved)
    if (done !== '' || !pass.complete) {
      logger.log(
        `billing ${job}: ${done || 'nothing done'}${pass.complete ? '' : ' (more is due)'}`,
      )
    }
  }

  async #pass(job: RenewalJob, deps: RenewalDeps): Promise<RenewalPass<string>> {
    switch (job) {
      case 'notices':
        return sendRenewalNotices(deps)
      case 'charges':
        return chargeRenewals(deps)
      case 'stuck_orders':
        return settleStuckOrders(deps)
      case 'period_ends': {
        const pass = await endPeriods(deps)
        // Once per tick: these tariffs are paid for until the shop is configured again.
        if (pass.waitingForShop > 0) {
          this.#options.logger.warn(
            `billing period_ends: ${pass.waitingForShop} subscriptions with auto-renewal are past ` +
              'the end of their period while payments are off; they stay active',
          )
        }
        return pass
      }
    }
  }
}

const MAX_ERROR_LENGTH = 300

/** The row and what went wrong. Ids only: no address, amount or payment method. */
function failureLine({ job, id, error }: RenewalFailureReport): string {
  const what = job === 'stuck_orders' ? 'order' : 'subscription'
  const reason = errorMessage(error).slice(0, MAX_ERROR_LENGTH)
  return `billing ${job}: ${what} ${id} not finished: ${reason}`
}
