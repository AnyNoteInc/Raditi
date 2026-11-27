import { describe, expect, it } from 'vitest'

import { classifyHostName, classifyIpAddress, ipLiteralBytes } from './ip-address.ts'

describe('classifyIpAddress', () => {
  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '77.88.55.88',
    // The neighbours of every range below.
    '9.255.255.255',
    '11.0.0.0',
    '100.63.255.255',
    '100.128.0.0',
    '126.255.255.255',
    '128.0.0.0',
    '169.253.255.255',
    '169.255.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '192.0.1.0',
    '192.167.255.255',
    '192.169.0.0',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
    '2a02:6b8::2:242',
    '2A02:6B8::2:242',
    '2000::',
    '2001:1::1',
    '2001:db7:ffff::1',
    '2001:db9::1',
    '2003::1',
    '3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  ])('accepts the public address %s everywhere', (address) => {
    expect(classifyIpAddress(address)).toBe('public')
  })

  it.each([
    '127.0.0.1',
    '127.255.255.255',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.168.255.255',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  ])('treats loopback, RFC 1918 and unique local %s as a local site', (address) => {
    expect(classifyIpAddress(address)).toBe('local')
  })

  it.each([
    // Unspecified, shared, link-local (cloud metadata), protocol assignments, benchmarking.
    '0.0.0.0',
    '0.1.2.3',
    '100.64.0.1',
    '100.127.255.255',
    '169.254.169.254',
    '192.0.0.1',
    '198.18.0.1',
    '198.19.255.255',
    // Multicast, reserved, broadcast.
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::2',
    // Link-local, site-local, multicast.
    'fe80::1',
    'febf::1',
    'fec0::1',
    'ff02::1',
    // An IPv4 address inside an IPv6 literal, in both spellings.
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:8.8.8.8',
    '::8.8.8.8',
    // NAT64, Teredo, documentation, 6to4.
    '64:ff9b::8.8.8.8',
    '64:ff9b::808:808',
    '2001::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001:db8::1',
    '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff',
    '2002::1',
    '2002:7f00:1::1',
    // Outside the global unicast block.
    '100::1',
    '1fff:ffff::1',
    '4000::1',
    'fbff::1',
    'fe00::1',
  ])('never accepts %s', (address) => {
    expect(classifyIpAddress(address)).toBeNull()
  })

  it.each([
    '',
    'example.ru',
    'localhost',
    '127.1',
    '0x7f.0.0.1',
    '0177.0.0.1',
    '01.2.3.4',
    '2130706433',
    '256.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '1.2.3.4 ',
    '[::1]',
    'fe80::1%eth0',
    '::1%lo',
    ':::',
    '1::2::3',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7:8::',
    '12345::1',
    'g::1',
    '::1.2.3',
    '::1.2.3.256',
    '1.2.3.4::1',
    '1:2:3:4:5:6:7:1.2.3.4',
  ])('answers null for %j, which is not an IP literal', (text) => {
    expect(classifyIpAddress(text)).toBeNull()
    expect(ipLiteralBytes(text)).toBeNull()
  })
})

describe('classifyHostName', () => {
  it.each([
    'example.ru',
    'EXAMPLE.RU',
    'shop.example.ru',
    'xn--e1afmkfd.xn--p1ai',
    'a-b.example.ru',
    '1.example.ru',
    'localhost.ru',
    'mylocalhost.ru',
    'test.ru',
    `${'a'.repeat(63)}.ru`,
    `${`${'a'.repeat(61)}.`.repeat(4)}ru`,
  ])('reads %s as a public name', (name) => {
    expect(classifyHostName(name)).toBe('public')
  })

  it.each([
    'localhost',
    'LOCALHOST',
    'host.localhost',
    'host.docker.internal',
    'wordpress',
    'wordpress.test',
    'printer.local',
    'nas.lan',
    'router.home',
    'home',
  ])('reads the single label or local zone %s as a local name', (name) => {
    expect(classifyHostName(name)).toBe('local')
  })

  it.each([
    '',
    'host.invalid',
    'invalid',
    'site.onion',
    'SITE.ONION',
    '-host',
    'host-.ru',
    'a..b',
    'example.ru.',
    '.example.ru',
    'exa_mple.ru',
    'exa mple.ru',
    'пример.рф',
    `${'a'.repeat(64)}.ru`,
    // 254 characters.
    `${`${'a'.repeat(62)}.`.repeat(4)}ru`,
    // The last label of a name has a letter: these are numbers, not names.
    '1.2.3',
    '0x7f.1',
    'example.1',
    '127.0.0.1',
    '::1',
  ])('never accepts the name %j', (name) => {
    expect(classifyHostName(name)).toBeNull()
  })
})
