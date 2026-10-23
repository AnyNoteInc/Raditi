import { dockerPreviewConfigSchema } from '@repo/sandbox-providers'
import { describe, expect, it } from 'vitest'

import type { PreviewsConfig } from '../config/config.ts'
import { previewRuntimeConfig } from './previews.providers.ts'

const previews: PreviewsConfig = {
  address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
  ttlHours: 72,
  executor: 'local',
  runtime: 'runc',
  webImages: {},
  images: { db: null, cli: null, forwarder: null, browser: null, egress: null },
  upstreamHost: '127.0.0.1',
  gatewayPort: 18090,
  egressRefusedSubnets: ['84.201.128.0/18'],
  docker: { socketPath: '/run/docker.sock', firewallImage: null },
}

describe('the runtime of previews in core', () => {
  it("gives the egress proxy of a preview the platform's subnets (R10)", () => {
    const config = previewRuntimeConfig(previews)
    expect(config).toEqual({
      runtime: 'runc',
      socketPath: '/run/docker.sock',
      gatewayPort: 18090,
      egressRefusedSubnets: ['84.201.128.0/18'],
    })
    expect(dockerPreviewConfigSchema.parse(config).egressRefusedSubnets).toEqual([
      '84.201.128.0/18',
    ])
  })

  it('runs none with runner VMs or without previews', () => {
    expect(previewRuntimeConfig({ ...previews, executor: 'runner', docker: null })).toBeNull()
    expect(previewRuntimeConfig(null)).toBeNull()
  })
})
