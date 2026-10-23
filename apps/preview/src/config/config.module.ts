import { Global, Module, type DynamicModule } from '@nestjs/common'

import type { PreviewGatewayConfig } from './config.ts'
import { PREVIEW_CLOCK, PREVIEW_CONFIG, type PreviewClock } from './config.tokens.ts'

/**
 * The configuration main.ts parsed before Nest existed, and the clock, for every module of the
 * app: global, so no module imports it. Called once per app (AppModule.forRoot, or a test's
 * module): Nest tells dynamic modules apart by reference.
 */
@Global()
@Module({})
export class PreviewConfigModule {
  static forRoot(config: PreviewGatewayConfig): DynamicModule {
    const clock: PreviewClock = Date.now
    return {
      module: PreviewConfigModule,
      providers: [
        { provide: PREVIEW_CONFIG, useValue: config },
        { provide: PREVIEW_CLOCK, useValue: clock },
      ],
      exports: [PREVIEW_CONFIG, PREVIEW_CLOCK],
    }
  }
}
