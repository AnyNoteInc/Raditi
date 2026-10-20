import { Module, type DynamicModule } from '@nestjs/common'
import { BACKGROUND_JOBS } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../infra/tokens.ts'

export interface CoreModuleOptions {
  config: CoreConfig
  /** Start BullMQ workers and polling loops; false in tests. */
  background: boolean
}

@Module({})
export class CoreConfigModule {
  static forRoot(options: CoreModuleOptions): DynamicModule {
    return {
      module: CoreConfigModule,
      global: true,
      providers: [
        { provide: CORE_CONFIG, useValue: options.config },
        { provide: BACKGROUND_JOBS, useValue: options.background },
      ],
      exports: [CORE_CONFIG, BACKGROUND_JOBS],
    }
  }
}
