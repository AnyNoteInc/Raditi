import type { AddressInfo } from 'node:net'

import type { INestApplication } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startMcp } from './start.ts'
import { testMcpConfig } from './testing/fakes.ts'

describe('startMcp', () => {
  let app: INestApplication | undefined

  beforeEach(() => {
    // The role logger writes straight to stdout.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.restoreAllMocks()
  })

  it('opens its port on 127.0.0.1 only outside production', async () => {
    app = await startMcp({ ...testMcpConfig(), port: 0 })

    expect((app.getHttpServer().address() as AddressInfo).address).toBe('127.0.0.1')
  })
})
