import {
  Module,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
} from '@nestjs/common'
import type { HealthChecks } from '@repo/observability'

import { HEALTH_DETAILS_TOKEN, HealthController } from './health.controller.ts'
import { HEALTH_CHECKS } from './tokens.ts'

/** A value the module makes from what it injects, as a Nest factory provider does. */
type Factory<T> = Pick<FactoryProvider<T>, 'useFactory' | 'inject'>

export interface HealthModuleOptions extends Factory<HealthChecks> {
  /** The modules whose exports the factories inject (the global ones need no import). */
  imports?: ModuleMetadata['imports']
  /** The bearer token that reveals a report's details; absent — GET /health answers status only. */
  details?: Factory<string>
}

/**
 * GET /health of an app with a database: HealthController over the checks the app makes
 * (HEALTH_CHECKS) and, when the app has an operator's token, the details behind it.
 */
@Module({})
export class HealthModule {
  static forRootAsync(options: HealthModuleOptions): DynamicModule {
    const { imports = [], details } = options
    return {
      module: HealthModule,
      imports,
      controllers: [HealthController],
      providers: [
        { provide: HEALTH_CHECKS, useFactory: options.useFactory, inject: options.inject ?? [] },
        ...(details
          ? [
              {
                provide: HEALTH_DETAILS_TOKEN,
                useFactory: details.useFactory,
                inject: details.inject ?? [],
              },
            ]
          : []),
      ],
    }
  }
}
