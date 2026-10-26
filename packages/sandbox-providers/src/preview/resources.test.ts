import type Docker from 'dockerode'
import { describe, expect, it } from 'vitest'

import {
  browserBridge,
  hostlessBridge,
  isHostlessBridge,
  isPreviewBridge,
  ownedIdentity,
  previewBridge,
  previewBridgeOptions,
  previewFilter,
  previewLabels,
  previewNames,
  subnetAddress,
} from './resources.ts'

const identity = {
  previewId: '0196abcd-0000-7000-8000-00000000000a',
  siteId: '0196abcd-0000-7000-8000-00000000000b',
  taskId: '0196abcd-0000-7000-8000-00000000000c',
}

describe('preview resources', () => {
  it('names bridges within the 15 bytes of a Linux interface, apart from attempt bridges', () => {
    const bridges = [previewBridge(identity.previewId), browserBridge(identity.previewId)]
    expect(bridges[0]).toMatch(/^rpv[0-9a-f]{12}$/)
    expect(bridges[1]).toBe(`rpb${bridges[0]!.slice(3)}`)
    for (const bridge of bridges) expect(bridge.length).toBeLessThanOrEqual(15)
    // UUIDv7 ids of one millisecond share their first 12 hex digits, never their bridges.
    const sameMillisecond = '0196abcd-0000-7000-8000-00000000000d'
    expect(previewBridge(sameMillisecond)).not.toBe(bridges[0])
    expect(browserBridge(sameMillisecond)).not.toBe(bridges[1])
    expect(previewNames(identity.previewId)).toMatchObject({
      network: `raditi-preview-${identity.previewId}`,
      filesVolume: `rpv-${identity.previewId}-files`,
      databaseVolume: `rpv-${identity.previewId}-db`,
    })
  })

  it('labels every resource and reads back only its own labels, of either protocol', () => {
    const labels = previewLabels(identity, 'preview', 1_800_000_000_000)
    expect(labels).toEqual({
      'io.raditi.preview.owner': 'raditi',
      'io.raditi.preview.protocol': '2',
      'io.raditi.preview.id': identity.previewId,
      'io.raditi.preview.site': identity.siteId,
      'io.raditi.preview.task': identity.taskId,
      'io.raditi.preview.deadline': '1800000000000',
      'io.raditi.preview.role': 'preview',
    })
    expect(ownedIdentity(labels)).toEqual({
      ...identity,
      role: 'preview',
      deadline: 1_800_000_000_000,
      protocol: '2',
    })
    // A preview of protocol 1 is still read: the runtime destroys it and builds it anew.
    expect(
      ownedIdentity({
        ...labels,
        'io.raditi.preview.protocol': '1',
        'io.raditi.preview.role': 'web',
      }),
    ).toMatchObject({ role: 'web', protocol: '1' })
    for (const broken of [
      { 'io.raditi.preview.owner': 'someone' },
      { 'io.raditi.preview.protocol': '3' },
      { 'io.raditi.preview.role': 'shell' },
      { 'io.raditi.preview.deadline': 'soon' },
      { 'io.raditi.preview.id': 'not-a-uuid' },
    ] as Record<string, string>[])
      expect(ownedIdentity({ ...labels, ...broken })).toBeNull()
    // The filter finds both protocols; ownedIdentity tells them apart.
    expect(previewFilter(identity.previewId, 'preview').label).toEqual([
      'io.raditi.preview.owner=raditi',
      `io.raditi.preview.id=${identity.previewId}`,
      'io.raditi.preview.role=preview',
    ])
  })

  it("accepts as the preview's own bridge only one that is not internal, without IPv6 and ICC", () => {
    const asked = previewBridgeOptions('raditi-preview-x', 'rpv0196abcd0000', {})
    expect(asked).toMatchObject({ Internal: false, EnableIPv6: false })
    const built = {
      Driver: 'bridge',
      Internal: false,
      EnableIPv6: false,
      Options: asked.Options,
      IPAM: { Config: [{ Subnet: '172.30.0.0/16', Gateway: '172.30.0.1' }] },
    } as unknown as Docker.NetworkInspectInfo
    expect(isPreviewBridge(built, 'rpv0196abcd0000')).toBe(true)
    for (const broken of [
      { Internal: true },
      { EnableIPv6: true },
      { Driver: 'overlay' },
      { Options: { ...asked.Options, 'com.docker.network.bridge.enable_icc': 'true' } },
      { Options: { 'com.docker.network.bridge.name': 'rpv0196abcd0001' } },
    ])
      expect(
        isPreviewBridge({ ...built, ...broken } as Docker.NetworkInspectInfo, 'rpv0196abcd0000'),
      ).toBe(false)
  })

  it('accepts only an internal, isolated, IPv4 bridge without a gateway on the host', () => {
    const asked = hostlessBridge('raditi-preview-x', 'rpv0196abcd0000', {})
    const built = {
      Driver: 'bridge',
      Internal: true,
      EnableIPv6: false,
      Options: asked.Options,
      IPAM: { Config: [{ Subnet: '172.23.0.0/16' }] },
    } as unknown as Docker.NetworkInspectInfo
    expect(isHostlessBridge(built, 'rpv0196abcd0000')).toBe(true)
    for (const patch of [
      { Internal: false },
      { EnableIPv6: true },
      { IPAM: { Config: [{ Subnet: '172.23.0.0/16', Gateway: '172.23.0.1' }] } },
      { Options: { ...asked.Options, 'com.docker.network.bridge.gateway_mode_ipv4': 'nat' } },
      { Driver: 'overlay' },
    ])
      expect(
        isHostlessBridge({ ...built, ...patch } as Docker.NetworkInspectInfo, 'rpv0196abcd0000'),
      ).toBe(false)
    expect(isHostlessBridge(built, 'rpvffffffffffff')).toBe(false)
  })

  it('puts fixed addresses inside the subnet Docker picked', () => {
    expect(subnetAddress('172.23.0.0/16', 2)).toBe('172.23.0.2')
    expect(subnetAddress('10.1.2.16/28', 5)).toBe('10.1.2.21')
    for (const [cidr, offset] of [
      ['172.23.0.1/16', 2],
      ['10.1.2.16/28', 15],
      ['10.1.2.16/30', 1],
      ['fd00::/64', 2],
      ['172.23.0.0', 2],
    ] as const)
      expect(() => subnetAddress(cidr, offset)).toThrow()
  })
})
