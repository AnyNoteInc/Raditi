import { Test, type TestingModule } from '@nestjs/testing'
import { siteAccessPath, type KvSecret, type SiteStack } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppModule } from '../app.module.ts'
import type { CoreConfig } from '../config/config.ts'
import { PreviewManager } from '../previews/preview-manager.ts'
import { ReleaseSkill } from '../releases/release-skill.ts'
import { UndoPlanner } from '../releases/undo-planner.ts'
import { fakeInfra, overrideCoreInfra, testCoreConfig } from '../testing/fakes.ts'
import { siteContentResolvers } from './site-content-access.ts'

const siteId = '0196abcd-0000-7000-8000-000000000004'
const workspaceId = '0196abcd-0000-7000-8000-000000000003'
const scope = {
  workspaceId,
  siteId,
  stack: 'wordpress' as SiteStack,
  url: 'https://site.example.test/',
}

/** The site's `wp` access: one credential_refs row and its secret in Vault. */
function siteAccess() {
  const findMany = vi.fn(async () => [
    {
      id: '0196abcd-0000-7000-8000-00000000aaaa',
      workspaceId,
      vaultPath: siteAccessPath(siteId, 'wp'),
      keyVersion: 1,
    },
  ])
  const kvRead = vi.fn(async (): Promise<KvSecret> => ({
    data: {
      v: '1',
      origin: 'https://site.example.test',
      username: 'raditi',
      applicationPassword: 'abcd efgh ijkl mnop',
    },
    version: 1,
  }))
  return { credentialRef: { findMany }, kvRead }
}

let moduleRef: TestingModule | undefined

afterEach(async () => {
  await moduleRef?.close()
  moduleRef = undefined
})

describe('siteContentResolvers', () => {
  it('makes a new resolver on every call, each with an access cache of its own', async () => {
    const site = siteAccess()
    const resolvers = siteContentResolvers({
      prisma: { credentialRef: site.credentialRef } as never,
      secrets: { kvRead: site.kvRead } as never,
      // Building a gateway sends nothing: no address is looked up.
      lookup: vi.fn(),
      appEnv: 'test',
    })
    const first = resolvers()
    const second = resolvers()
    expect(first).not.toBe(second)

    const gateway = await first(scope)
    expect(await first(scope)).toBe(gateway)
    expect(site.kvRead).toHaveBeenCalledOnce()
    // The other one reads the site's access for itself and builds its own gateway.
    expect(await second(scope)).not.toBe(gateway)
    expect(site.kvRead).toHaveBeenCalledTimes(2)
  })
})

describe('SiteContentModule', () => {
  it('gives the preview manager, the release skill and the undo planner a resolver each', async () => {
    const site = siteAccess()
    const infra = fakeInfra()
    Object.assign(infra.prisma, { credentialRef: site.credentialRef })
    Object.assign(infra.secrets, { kvRead: site.kvRead })
    // Previews on runner VMs: the manager is built, core's own Docker is not.
    const config: CoreConfig = {
      ...testCoreConfig(),
      previews: {
        address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
        ttlHours: 72,
        executor: 'runner',
        runtime: 'runc',
        webImages: {},
        images: { db: null, cli: null, forwarder: null, browser: null, egress: null },
        upstreamHost: '127.0.0.1',
        gatewayPort: 8090,
        egressRefusedSubnets: [],
        docker: null,
      },
    }
    const builder = Test.createTestingModule({
      imports: [AppModule.forRoot({ config, background: false })],
    })
    // Compiling builds every provider; nothing of the lifecycle needs to run.
    moduleRef = await overrideCoreInfra(builder, infra).compile()

    for (const consumer of [PreviewManager, ReleaseSkill, UndoPlanner]) {
      // The production gateway as the consumer was handed it.
      const { production } = (
        moduleRef.get(consumer) as unknown as { deps: { production: Resolve } }
      ).deps
      await production(scope)
      await production(scope)
    }
    // One read of the access per consumer: a resolver shared by two would read it once for both.
    expect(site.kvRead).toHaveBeenCalledTimes(3)
  })
})

type Resolve = (scope: {
  workspaceId: string
  siteId: string
  stack: SiteStack
  url: string
}) => Promise<unknown>
