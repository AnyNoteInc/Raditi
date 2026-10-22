import { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import { LlmConfigModule } from '../config/config.module.ts'
import { InfraModule } from '../infra/infra.module.ts'
import { testRole, testRoleConfig as config } from '../testing/role.ts'

const createStore = vi.hoisted(() => vi.fn())
vi.mock('./gateway-store.ts', () => ({
  PostgresGatewayStore: class {
    constructor(_db: unknown, options: unknown) {
      createStore(options)
    }
  },
}))

import { AccountingModule } from './accounting.module.ts'

describe('llm role lifecycle', () => {
  it('reports rows the gateway collector cannot close and keeps the per-key limits', async () => {
    const app = await testRole([
      LlmConfigModule.forRoot({ ...config(), maxCallsPerKey30s: 7, maxCallsPerKey: 70 }),
      InfraModule,
      AccountingModule,
    ]).compile()
    const options = createStore.mock.calls[0]![0] as {
      maxRequestsPerKey: number
      maxCallsPerKey30s: number
      maxCallsPerKey: number
      logger?: { warn(message: string): void }
    }
    expect(options.maxRequestsPerKey).toBe(2)
    // The pace and the ceiling of a key come from the configuration of the role.
    expect(options).toMatchObject({ maxCallsPerKey30s: 7, maxCallsPerKey: 70 })
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    options.logger!.warn('{"event":"llm_collector_row_failed","kind":"call"}')
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '{"event":"llm_collector_row_failed","kind":"call"}',
    )
    warn.mockRestore()
    await app.close()
  })
})
