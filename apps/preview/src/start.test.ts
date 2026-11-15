import type { INestApplicationContext } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserStreamListener } from './browser-stream/browser-stream.ts'
import { PagesServer } from './pages/pages-server.ts'
import { startPreview } from './start.ts'
import { testPreviewConfigOnFreePorts } from './testing/fakes.ts'

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

  it('opens the pages on 127.0.0.1 outside production and answers the health of the role there', async () => {
    app = await startPreview(testPreviewConfigOnFreePorts())
    const address = app.get(PagesServer).address()
    expect(address?.address).toBe('127.0.0.1')
    const health = await fetch(`http://127.0.0.1:${address?.port}/__raditi/health`)
    expect(health.status).toBe(200)
    expect(await health.text()).toBe('ok')
    // Only on a host that is not a page's, and only GET.
    expect(
      (await fetch(`http://127.0.0.1:${address?.port}/__raditi/health`, { method: 'POST' })).status,
    ).toBe(404)
    // No worker configured: no stream listener at all.
    expect(() => app?.get(BrowserStreamListener)).toThrow()
  })

  it('opens the stream of a chat browser on its own port when the worker is configured', async () => {
    app = await startPreview({
      ...testPreviewConfigOnFreePorts(),
      browserStream: {
        port: 0,
        host: '127.0.0.1',
        workerUrl: 'http://127.0.0.1:8086',
        workerToken: 'worker-token-0123456789abcdef0123456789abcdef',
      },
    })
    const pages = app.get(PagesServer).address()
    const listener = app.get(BrowserStreamListener)
    const stream = listener.address()
    expect(stream?.address).toBe('127.0.0.1')
    expect(stream?.port).not.toBe(pages?.port)
    expect((await fetch(`http://127.0.0.1:${stream?.port}/v1/browser/stream`)).status).toBe(426)
    // It closes with the app (the order against the database: app.module.test.ts).
    await app.close()
    app = undefined
    expect(listener.address()).toBeNull()
  })
})
