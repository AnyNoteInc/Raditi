// The gateway of previews in a Nest testing module, without the database: the store and the
// clock are the test's. Only for *.test.ts files.
import { Test, type TestingModule } from '@nestjs/testing'

import { PREVIEW_ACCESS_STORE } from '../access/access.tokens.ts'
import type { PreviewAccessStore } from '../access/preview-access.ts'
import { PreviewConfigModule } from '../config/config.module.ts'
import { PREVIEW_CLOCK, type PreviewClock } from '../config/config.tokens.ts'
import type { PreviewGatewayConfig } from '../config/config.ts'
import { GatewayModule } from '../gateway/gateway.module.ts'
import { testPreviewConfig } from './fakes.ts'

export interface TestGatewayOptions {
  store: PreviewAccessStore
  now?: PreviewClock
  /** Over testPreviewConfig(). */
  config?: Partial<PreviewGatewayConfig>
}

/**
 * GatewayModule as AppModule imports it: get PreviewGatewayServer from the module and listen on
 * it; close the module to stop the gateway as the app does. Nest's testing logger keeps the
 * gateway's warnings out of the output.
 */
export function createTestGateway({
  store,
  now = Date.now,
  config = {},
}: TestGatewayOptions): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [PreviewConfigModule.forRoot({ ...testPreviewConfig(), ...config }), GatewayModule],
  })
    .overrideProvider(PREVIEW_ACCESS_STORE)
    .useValue(store)
    .overrideProvider(PREVIEW_CLOCK)
    .useValue(now)
    .compile()
}
