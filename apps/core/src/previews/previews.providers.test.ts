import { dockerPreviewConfigSchema } from '@repo/sandbox-providers'
import { describe, expect, it } from 'vitest'

import type { PreviewsConfig } from '../config/config.ts'
import { previewRuntimeConfig } from './previews.providers.ts'

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
