import { Test } from '@nestjs/testing'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import type { SandboxProvider } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { CoreConfigModule } from '../core/core-config.module.ts'
import { AGENT_DRIVERS, SANDBOX_PROVIDER } from '../infra/tokens.ts'
import { SandboxModule } from '../sandbox/sandbox.module.ts'
import { testCoreConfig } from '../testing/fakes.ts'
import { DriversModule, ENABLED_AGENT_DRIVERS } from './drivers.module.ts'

describe('DriversModule and SandboxModule', () => {
  it('provide the agent driver registry and the sandbox provider', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CoreConfigModule.forRoot({ config: testCoreConfig(), background: false }),
        DriversModule,
        SandboxModule,
      ],
    }).compile()

    const drivers = moduleRef.get<AgentDriverRegistry>(AGENT_DRIVERS)
    expect(drivers.list().map((driver) => driver.id)).toEqual([...ENABLED_AGENT_DRIVERS])
    expect(drivers.get('codex').image).toBe('raditi/agent-codex')
    expect(() => drivers.get('opencode')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))

    const sandbox = moduleRef.get<SandboxProvider>(SANDBOX_PROVIDER)
    expect(sandbox.kind).toBe('docker')

    await moduleRef.close()
  })
})
