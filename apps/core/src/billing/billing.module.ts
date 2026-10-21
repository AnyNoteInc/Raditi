import { Logger, Module } from '@nestjs/common'
import { Counter, type Registry } from '@prometheus-io/client'
import { renewalJobs, renewalOutcomes, type RenewalDeps } from '@repo/billing'
import type { PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG, YOOKASSA, METRICS_REGISTRY } from '../infra/tokens.ts'
import { MetricsModule } from '../metrics/metrics.module.ts'
import { BillingJobs } from './billing-jobs.ts'
import { BillingScheduler } from './billing-scheduler.ts'
import { BillingProcessor } from './billing.processor.ts'

/**
 * Renewal of tariffs in the core role (docs/plan/37-billing-plan.md, M5.11): the schedulers
 * of the four passes, the worker of their queue and the counter of what the passes did. The
 * passes themselves are @repo/billing; web takes payments, core only renews them. Without a
 * shop (CoreConfig.yookassa is null) the passes run and charge nobody.
 */
@Module({
  imports: [MetricsModule],
  providers: [
    {
      provide: BillingJobs,
      useFactory: (
        prisma: PrismaClient,
        yookassa: RenewalDeps['yookassa'],
        config: CoreConfig,
        registry: Registry,
      ) => {
        // Rows by pass and outcome: no workspace, subscription or order in a label.
        const rows = new Counter({
          name: 'raditi_billing_renewal_rows_total',
          help: 'Rows of the billing renewal passes by how they ended',
          labelNames: ['job', 'outcome'],
          registers: [registry],
        })
        for (const job of renewalJobs) {
          for (const outcome of renewalOutcomes[job]) rows.inc({ job, outcome }, 0)
        }
        return new BillingJobs({
          prisma,
          yookassa,
          config: config.billing,
          count: (job, outcome, count) => rows.inc({ job, outcome }, count),
          logger: new Logger('Billing'),
        })
      },
      inject: [PRISMA, YOOKASSA, CORE_CONFIG, METRICS_REGISTRY],
    },
    BillingProcessor,
    BillingScheduler,
  ],
})
export class BillingModule {}
