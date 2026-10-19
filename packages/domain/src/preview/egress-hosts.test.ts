import { describe, expect, it } from 'vitest'

import {
  egressHostListSchema,
  egressHostSchema,
  formatEgressHost,
  isEgressAddressAllowed,
  parseEgressHost,
  parseIpSubnet,
} from './egress-hosts.ts'

describe('hosts of a variable', () => {
  it('takes a public name with an optional port, 443 by default', () => {
    expect(parseEgressHost('api.example.ru')).toEqual({ host: 'api.example.ru', port: 443 })
    expect(parseEgressHost('API.Example.ru:8443')).toEqual({ host: 'api.example.ru', port: 8443 })
    expect(parseEgressHost('xn--80aswg.xn--p1ai')).toEqual({
      host: 'xn--80aswg.xn--p1ai',
      port: 443,
    })
    expect(formatEgressHost({ host: 'api.example.ru', port: 443 })).toBe('api.example.ru:443')
    expect(egressHostSchema.parse('Api.Example.ru')).toBe('api.example.ru:443')
  })

  it('refuses addresses in every spelling and the names that never leave a machine', () => {
    for (const text of [
      '127.0.0.1',
      '10.0.0.1:443',
      '169.254.169.254',
      '0.0.0.0',
      '127.1',
      '2130706433',
      '0x7f.1',
      '0x7f000001',
      '[::1]',
      '::1',
      'fe80::1',
      'localhost',
      'localhost:443',
      'api.localhost',
      'metadata.google.internal',
      'host.docker.internal',
      'printer.local',
      'site.test',
      'router.lan',
      'nas.home',
      'intranet',
      'secret.onion',
      'x.invalid',
      'api.example.ru.',
      'api.example.ru:0',
      'api.example.ru:65536',
      'api.example.ru:443/path',
      'user@api.example.ru',
      'https://api.example.ru',
      'api_example.ru',
      'api..example.ru',
      '',
    ])
      expect(parseEgressHost(text), text).toBeNull()
  })

  it('takes up to sixteen different hosts of a variable', () => {
    const hosts = Array.from({ length: 16 }, (_, i) => `h${i}.example.ru`)
    expect(egressHostListSchema.parse(hosts)).toHaveLength(16)
    expect(egressHostListSchema.safeParse([...hosts, 'h16.example.ru']).success).toBe(false)
    expect(egressHostListSchema.safeParse(['a.example.ru', 'A.example.ru:443']).success).toBe(false)
  })
})

describe('addresses the proxy connects to', () => {
  it('allows a public unicast address', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '2a00:1450:4010:c05::64'])
      expect(isEgressAddressAllowed(address), address).toBe(true)
  })

  it('refuses private, loopback, link-local, metadata, CGNAT, ULA, multicast and this network', () => {
    for (const address of [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '100.127.255.255',
      '0.0.0.0',
      '0.1.2.3',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:10.0.0.1',
      '::ffff:8.8.8.8',
      '64:ff9b::808:808',
      'example.ru',
      '',
    ])
      expect(isEgressAddressAllowed(address), address).toBe(false)
  })

  it('refuses the platform’s own subnets', () => {
    const subnets = ['84.201.128.0/18', '2a02:6b8:c00::/40'].map((text) => {
      const subnet = parseIpSubnet(text)
      if (subnet === null) throw new Error(text)
      return subnet
    })
    expect(isEgressAddressAllowed('84.201.130.7', subnets)).toBe(false)
    expect(isEgressAddressAllowed('84.201.192.7', subnets)).toBe(true)
    expect(isEgressAddressAllowed('2a02:6b8:c00::1', subnets)).toBe(false)
    expect(isEgressAddressAllowed('2a02:6b8:d00::1', subnets)).toBe(true)
  })

  it('reads a subnet only as an address and a prefix that fits it', () => {
    expect(parseIpSubnet('10.0.0.0/8')).toEqual({ bytes: [10, 0, 0, 0], prefix: 8 })
    for (const text of ['10.0.0.0', '10.0.0.0/33', '::/129', 'x/8', '10.0.0.0/08', '10.0.0.0/-1'])
      expect(parseIpSubnet(text), text).toBeNull()
  })
})
