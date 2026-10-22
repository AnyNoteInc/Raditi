import type { INestApplicationContext } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PreviewGatewayServer } from './gateway/preview-gateway.server.ts'
import { startPreview } from './start.ts'
import { testPreviewConfig } from './testing/fakes.ts'

describe('startPreview', () => {
  let app: INestApplicationContext | undefined

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.restoreAllMocks()
  })

  it('opens its port on 127.0.0.1 outside production and answers its health', async () => {
    app = await startPreview({ ...testPreviewConfig(), port: 0 })
    const address = app.get(PreviewGatewayServer).address()
    expect(address?.address).toBe('127.0.0.1')
    const health = await fetch(`http://127.0.0.1:${address?.port}/__raditi/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
  })
})
