import { Module } from '@nestjs/common'

import { EgressModule } from '../egress/egress.module.ts'
import { PoolModule } from '../pool/pool.module.ts'
import { ChannelMonitor } from './channel-monitor.ts'
import { MaintenanceJobs } from './maintenance-jobs.ts'
import { PoolTicker } from './pool-ticker.ts'

/** The timers of the role: the pass of the pool and the probes of the channel. */
@Module({
  imports: [EgressModule, PoolModule],
  providers: [MaintenanceJobs, ChannelMonitor, PoolTicker],
  exports: [MaintenanceJobs, ChannelMonitor, PoolTicker],
})
export class MaintenanceModule {}
