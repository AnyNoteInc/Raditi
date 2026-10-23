import { NestFactory } from '@nestjs/core'
import { describe, expect, it, vi } from 'vitest'

const { createPrismaClient, events } = vi.hoisted(() => {
  const events: string[] = []
  const createPrismaClient = vi.fn(() => ({
    $disconnect: vi.fn(() => {
      events.push('database')
      return Promise.resolve()
    }),
  }))
  return { createPrismaClient, events }
})
// The rest of @repo/db stays: the configuration of the app parses DATABASE_URL with it.
vi.mock('@repo/db', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPrismaClient,
}))

const { AppModule } = await import('./app.module.ts')
const { PreviewGatewayServer } = await import('./gateway/preview-gateway.server.ts')
const { testPreviewConfig } = await import('./testing/fakes.ts')

describe('AppModule', () => {
  it('closes the pool of the database after the gateway has closed', async () => {
    const app = await NestFactory.createApplicationContext(AppModule.forRoot(testPreviewConfig()), {
      logger: false,
    })
    const gateway = app.get(PreviewGatewayServer)
    await gateway.listen(0, '127.0.0.1')
    const close = gateway.close.bind(gateway)
    vi.spyOn(gateway, 'close').mockImplementation(async () => {
      await close()
      events.push('gateway')
    })

    await app.close()

    // The database module is global: Nest stops it after every other module.
    expect(events).toEqual(['gateway', 'database'])
    expect(createPrismaClient).toHaveBeenCalledOnce()
  })

  it('gives startPreview the server of the gateway, which no module exports', async () => {
    // No module injects the server (plan 56, §3, item 4); app.get looks in every module.
    const { GatewayModule } = await import('./gateway/gateway.module.ts')
    expect(Reflect.getMetadata('exports', GatewayModule)).toBeUndefined()
    const app = await NestFactory.createApplicationContext(AppModule.forRoot(testPreviewConfig()), {
      logger: false,
    })
    const gateway = app.get(PreviewGatewayServer)
    expect(gateway).toBeInstanceOf(PreviewGatewayServer)
    expect(app.select(GatewayModule).get(PreviewGatewayServer, { strict: true })).toBe(gateway)
    await app.close()
  })
})
