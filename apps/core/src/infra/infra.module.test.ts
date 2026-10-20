import { Buffer } from 'node:buffer'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Test } from '@nestjs/testing'
import type { YookassaClient } from '@repo/yookassa'
import { afterEach, describe, expect, it } from 'vitest'
import { OBJECT_STORAGE, PRISMA, SECRET_STORE } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { CoreConfigModule } from '../core/core-config.module.ts'
import { fakeInfra, testCoreConfig } from '../testing/fakes.ts'
import { InfraModule } from './infra.module.ts'
import { YOOKASSA, REDIS } from './tokens.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  )
})

function compile(config: CoreConfig) {
  const infra = fakeInfra()
  return Test.createTestingModule({
    imports: [CoreConfigModule.forRoot({ config, background: false }), InfraModule],
  })
    .overrideProvider(PRISMA)
    .useValue(infra.prisma)
    .overrideProvider(REDIS)
    .useValue(infra.redis)
    .overrideProvider(OBJECT_STORAGE)
    .useValue(infra.storage)
    .overrideProvider(SECRET_STORE)
    .useValue(infra.secrets)
    .compile()
}

describe('InfraModule: the ЮKassa client', () => {
  it('provides none while payments are off', async () => {
    expect(testCoreConfig().yookassa).toBeNull()
    const moduleRef = await compile(testCoreConfig())

    expect(moduleRef.get<YookassaClient | null>(YOOKASSA)).toBeNull()
    await moduleRef.close()
  })

  it('provides a client of the configured shop that calls the configured address', async () => {
    const requests: { url: string | undefined; authorization: string | undefined }[] = []
    const server = createServer((req, res) => {
      requests.push({ url: req.url, authorization: req.headers.authorization })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'pmt_1',
          status: 'succeeded',
          paid: true,
          amount: { value: '4900.00', currency: 'RUB' },
          created_at: '2026-10-04T00:00:00Z',
        }),
      )
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    const moduleRef = await compile({
      ...testCoreConfig(),
      yookassa: {
        shopId: '123456',
        secretKey: 'test_shop-secret-key',
        baseUrl: `http://127.0.0.1:${port}/v3`,
        webhookAllowlist: ['127.0.0.1'],
        autopayments: true,
      },
    })
    const client = moduleRef.get<YookassaClient>(YOOKASSA)

    expect((await client.getPayment('pmt_1')).status).toBe('succeeded')
    expect(requests).toEqual([
      {
        url: '/v3/payments/pmt_1',
        authorization: `Basic ${Buffer.from('123456:test_shop-secret-key').toString('base64')}`,
      },
    ])
    // The credentials stay inside the client: nothing of them shows on the provided object.
    expect(JSON.stringify(client)).not.toContain('test_shop-secret-key')
    await moduleRef.close()
  })
})
