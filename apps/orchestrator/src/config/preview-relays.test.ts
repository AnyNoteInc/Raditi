import { describe, expect, it } from 'vitest'

import { loadConfig } from './config.ts'
import { DEV_PREVIEW_BROWSER_RELAYS, parsePreviewRelays } from './preview-relays.ts'

describe('PREVIEW_BROWSER_RELAYS', () => {
  it('is this machine and the Docker bridges outside production, nobody in production', () => {
    expect(
      parsePreviewRelays(undefined, false).ranges.map((r) => `${r.address}/${r.prefix}`),
    ).toEqual(DEV_PREVIEW_BROWSER_RELAYS.split(','))
    expect(parsePreviewRelays(undefined, true)).toEqual({ ranges: [], problems: [] })
  })

  it('takes IP CIDRs only, private or loopback in production', () => {
    expect(parsePreviewRelays('10.10.1.0/24, ::ffff:127.0.0.1/32', true)).toEqual({
      ranges: [
        { address: '10.10.1.0', prefix: 24, family: 'ipv4' },
        { address: '127.0.0.1', prefix: 32, family: 'ipv4' },
      ],
      problems: [],
    })
    expect(parsePreviewRelays('203.0.113.0/24', true).problems).toEqual([
      'PREVIEW_BROWSER_RELAYS: only private or loopback ranges in production (spec §19)',
    ])
    expect(parsePreviewRelays('203.0.113.0/24', false).problems).toEqual([])
    // A range that starts at a private address but reaches past its block is no private range:
    // 10.0.0.0/1 holds 8.8.8.8, 172.16.0.0/8 holds 172.1.2.3, fc00::/6 holds public space.
    for (const wide of ['10.0.0.0/1', '10.0.0.0/0', '172.16.0.0/8', '192.168.0.0/15', 'fc00::/6'])
      expect(parsePreviewRelays(wide, true).problems, wide).toEqual([
        'PREVIEW_BROWSER_RELAYS: only private or loopback ranges in production (spec §19)',
      ])
    expect(
      parsePreviewRelays('10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fd00::/8, ::1/128', true)
        .problems,
    ).toEqual([])
    for (const bad of ['localhost/32', '10.0.0.1', '10.0.0.0/33', '::1/129', '10.0.0.0/8/1', 'x'])
      expect(parsePreviewRelays(bad, false).problems, bad).toEqual([
        'PREVIEW_BROWSER_RELAYS: must be a comma-separated list of IP CIDRs',
      ])
  })

  it('reaches the gateway configuration of the preview role', () => {
    const env = {
      APP_ENV: 'development',
      APP_URL: 'http://localhost:3000',
      ORCHESTRATOR_ROLES: 'preview',
      DATABASE_URL: 'postgresql://raditi:raditi@localhost:5432/raditi',
      PREVIEW_BASE_DOMAIN: 'localhost',
    }
    expect(
      loadConfig({ ...env, PREVIEW_BROWSER_RELAYS: '192.168.65.0/24' }).preview?.browserRelays,
    ).toEqual([{ address: '192.168.65.0', prefix: 24, family: 'ipv4' }])
    expect(() => loadConfig({ ...env, PREVIEW_BROWSER_RELAYS: 'nope' })).toThrow(
      /PREVIEW_BROWSER_RELAYS: must be a comma-separated list of IP CIDRs/,
    )
  })
})
