import type { FactoryProvider } from '@nestjs/common'
import { dockerPreviewConfigSchema } from '@repo/sandbox-providers'
import { findSiteContentAdapter, getSiteAdapter, getSiteContentAdapter } from '@repo/site-adapters'
import { describe, expect, it } from 'vitest'

import type { CoreConfig, PreviewsConfig } from '../config/config.ts'
import type { PreviewBuildDeps } from './preview-builder.ts'
import { PreviewManager } from './preview-manager.ts'
import { previewProviders, previewRuntimeConfig, previewStacks } from './previews.providers.ts'

const guard = `registry.invalid/guard@sha256:${'6'.repeat(64)}`

const previews: PreviewsConfig = {
  address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
  ttlHours: 72,
  idleMinutes: 30,
  executor: 'local',
  runtime: 'runc',
  siteImages: {},
  images: { db: null, forwarder: null, browser: null },
  upstreamHost: '127.0.0.1',
  dnsServers: ['77.88.8.8', '77.88.8.1'],
  gatewayPort: 18090,
  refusedSubnets: ['84.201.128.0/18'],
  docker: { socketPath: '/run/docker.sock', firewallImage: guard },
}

describe('the runtime of previews in core', () => {
  it("closes the platform's subnets on the bridge of a preview, its internet open (plan 58)", () => {
    const config = previewRuntimeConfig(previews)
    expect(config).toEqual({
      runtime: 'runc',
      socketPath: '/run/docker.sock',
      gatewayPort: 18090,
      firewallImage: guard,
      refusedSubnets: ['84.201.128.0/18'],
      dnsServers: ['77.88.8.8', '77.88.8.1'],
    })
    expect(dockerPreviewConfigSchema.parse(config).refusedSubnets).toEqual(['84.201.128.0/18'])
  })

  it('runs none with runner VMs, without previews or without the image of the host rules', () => {
    expect(previewRuntimeConfig({ ...previews, executor: 'runner', docker: null })).toBeNull()
    expect(previewRuntimeConfig(null)).toBeNull()
    expect(
      previewRuntimeConfig({
        ...previews,
        docker: { socketPath: '/run/docker.sock', firewallImage: null },
      }),
    ).toBeNull()
  })
})

describe('the adapters of the stacks a preview is built with', () => {
  it('gives a stack without published content no plugin, not an error (Т8)', () => {
    expect(previewStacks.contentAdapters('wordpress')).toBe(getSiteContentAdapter('wordpress'))
    expect(previewStacks.contentAdapters('bitrix')).toBeNull()
  })

  it('does not take an unknown stack for one without a plugin', () => {
    expect(() => previewStacks.contentAdapters('drupal' as never)).toThrow(/Unknown site stack/)
  })

  it('gives the manager its factory builds those adapters, not ones of its own', () => {
    const provider = previewProviders.find(
      (one): one is FactoryProvider => typeof one === 'object' && one.provide === PreviewManager,
    )
    if (!provider) throw new Error('no PreviewManager factory')
    const config = {
      appEnv: 'test',
      previews: { ...previews, executor: 'runner', docker: null },
    } as unknown as CoreConfig
    const stub = {} as never
    const manager: unknown = provider.useFactory(
      config,
      stub,
      null,
      null,
      stub,
      stub,
      stub,
      stub,
      stub,
      () => stub,
      stub,
    )
    expect(manager).toBeInstanceOf(PreviewManager)
    // The dependencies are the manager's own; read here only to see what the factory gave it.
    const deps = (manager as { deps: PreviewBuildDeps }).deps
    expect(deps.adapters).toBe(getSiteAdapter)
    expect(deps.contentAdapters).toBe(findSiteContentAdapter)
    expect(deps.contentAdapters('bitrix')).toBeNull()
  })
})
