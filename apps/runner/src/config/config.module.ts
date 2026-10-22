import { Module, type DynamicModule } from '@nestjs/common'

import type { RunnerConfig, RunnerOptions } from './config.ts'
import { RUNNER_CONFIG, RUNNER_OPTIONS } from './config.tokens.ts'

/**
 * The configuration of the runner for every module of it: global, so the feature modules read
 * it by token. Created once, by AppModule.forRoot: Nest tells dynamic modules apart by
 * reference, and a second call would give a second set of providers.
 */
@Module({})
export class RunnerConfigModule {
  static forRoot(config: RunnerConfig, options: RunnerOptions = {}): DynamicModule {
    return {
      module: RunnerConfigModule,
      global: true,
      providers: [
        { provide: RUNNER_CONFIG, useValue: config },
        { provide: RUNNER_OPTIONS, useValue: options },
      ],
      exports: [RUNNER_CONFIG, RUNNER_OPTIONS],
    }
  }
}
