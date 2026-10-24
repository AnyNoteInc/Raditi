import type { INestApplicationContext } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserStreamListener } from './browser-stream/browser-stream.ts'
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
    // No worker configured: no stream listener at all.
    expect(() => app?.get(BrowserStreamListener)).toThrow()
  })

  it('opens the stream of a task browser on its own port when the worker is configured', async () => {
    app = await startPreview({
      ...testPreviewConfig(),
      port: 0,
      browserStream: {
        port: 0,
        host: '127.0.0.1',
        workerUrl: 'http://127.0.0.1:8086',
        workerToken: 'worker-token-0123456789abcdef0123456789abcdef',
      },
    })
    const preview = app.get(PreviewGatewayServer).address()
    const listener = app.get(BrowserStreamListener)
    const stream = listener.address()
    expect(stream?.address).toBe('127.0.0.1')
    expect(stream?.port).not.toBe(preview?.port)
    expect((await fetch(`http://127.0.0.1:${stream?.port}/v1/browser/stream`)).status).toBe(426)
    // Health stays where it was.
    expect((await fetch(`http://127.0.0.1:${preview?.port}/__raditi/health`)).status).toBe(200)
    // It closes with the app (the order against the database: app.module.test.ts).
    await app.close()
    app = undefined
    expect(listener.address()).toBeNull()
  })
})
