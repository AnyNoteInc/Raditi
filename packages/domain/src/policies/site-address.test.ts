import { describe, expect, it } from 'vitest'

import {
  classifySiteAddress,
  classifySiteHostName,
  isSiteAddressAllowed,
  normalizeSiteHost,
  siteAddressFamily,
} from './site-address.ts'

describe('classifySiteAddress', () => {
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
    expect(classifySiteAddress(address)).toBe('public')
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
    expect(classifySiteAddress(address)).toBe('local')
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
    expect(classifySiteAddress(address)).toBeNull()
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
    expect(classifySiteAddress(text)).toBeNull()
    expect(siteAddressFamily(text)).toBe(0)
  })
})

describe('siteAddressFamily', () => {
  it('tells the family of a literal and nothing about a name', () => {
    expect(siteAddressFamily('127.0.0.1')).toBe(4)
    expect(siteAddressFamily('255.255.255.255')).toBe(4)
    expect(siteAddressFamily('::1')).toBe(6)
    expect(siteAddressFamily('2a02:6b8::2:242')).toBe(6)
    expect(siteAddressFamily('::ffff:1.2.3.4')).toBe(6)
    expect(siteAddressFamily('1:2:3:4:5:6:7::')).toBe(6)
    expect(siteAddressFamily('example.ru')).toBe(0)
    expect(siteAddressFamily('1e3')).toBe(0)
  })
})

describe('classifySiteHostName', () => {
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
    expect(classifySiteHostName(name)).toBe('public')
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
    expect(classifySiteHostName(name)).toBe('local')
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
    expect(classifySiteHostName(name)).toBeNull()
  })
})

describe('isSiteAddressAllowed', () => {
  it('accepts a public address everywhere, a local one outside production and null never', () => {
    for (const appEnv of ['development', 'test', 'production'] as const) {
      expect(isSiteAddressAllowed('public', appEnv)).toBe(true)
      expect(isSiteAddressAllowed('local', appEnv)).toBe(appEnv !== 'production')
      expect(isSiteAddressAllowed(null, appEnv)).toBe(false)
    }
  })
})

describe('normalizeSiteHost', () => {
  it.each([
    ['example.ru', 'example.ru'],
    ['EXAMPLE.Ru', 'example.ru'],
    ['example.ru.', 'example.ru'],
    ['localhost.', 'localhost'],
    ['Пример.РФ', 'xn--e1afmkfd.xn--p1ai'],
    ['кофейня.рф', 'xn--e1aiboc0b6e.xn--p1ai'],
    // The address forms a browser accepts become the dotted quad before anything classifies them.
    ['127.1', '127.0.0.1'],
    ['0x7f.1', '127.0.0.1'],
    ['2130706433', '127.0.0.1'],
    ['0x7f000001', '127.0.0.1'],
    ['0177.0.0.1', '127.0.0.1'],
    ['127.0.0.1.', '127.0.0.1'],
    ['192.168.1.10', '192.168.1.10'],
    ['::1', '::1'],
    ['[::1]', '::1'],
    ['[0:0:0:0:0:0:0:1]', '::1'],
    ['2001:DB8::1', '2001:db8::1'],
    ['::ffff:127.0.0.1', '::ffff:7f00:1'],
    // Shape only: the classifier refuses this name later, with its own reason.
    ['exa_mple.ru', 'exa_mple.ru'],
  ])('stores %s as %s', (text, host) => {
    expect(normalizeSiteHost(text)).toBe(host)
  })

  it.each([
    '',
    ' ',
    '.',
    // One trailing dot is the root of a name; after a second one an empty label is left.
    '..',
    'example.ru..',
    'example.ru...',
    'localhost..',
    '127.0.0.1..',
    'пример.рф..',
    'http://example.ru',
    'https://example.ru/',
    'example.ru:8080',
    '127.0.0.1:21',
    '[::1]:22',
    'example.ru/',
    'example.ru/wp-admin',
    'example.ru?x=1',
    'example.ru#x',
    'user@example.ru',
    'user:password@example.ru',
    'example.ru\\admin',
    ' example.ru',
    'exa mple.ru',
    'exa\tmple.ru',
    'exa\nmple.ru',
    'exa\u0000mple.ru',
    'exa\u007fmple.ru',
    'ex%41mple.ru',
    '999.1.1.1',
    '[::1',
    '::1]',
    '[[::1]]',
    '[]',
    '[example.ru]',
    'fe80::1%eth0',
    '[fe80::1%25eth0]',
  ])('answers null for %j, which is not a bare host', (text) => {
    expect(normalizeSiteHost(text)).toBeNull()
  })

  it('leaves nothing for a second pass: a stored host is its own normal form', () => {
    for (const text of ['Пример.РФ', '127.1', '[2001:DB8::1]', 'example.ru.', 'LOCALHOST']) {
      const host = normalizeSiteHost(text)
      expect(host).not.toBeNull()
      expect(normalizeSiteHost(host ?? '')).toBe(host)
    }
  })

  it('never stores a trailing dot, however many were typed', () => {
    const names = ['example.ru', 'EXAMPLE.RU', 'a', 'localhost', '127.0.0.1', '127.1', 'пример.рф']
    for (const name of names)
      for (const dots of ['', '.', '..', '...', '.'.repeat(8)]) {
        const host = normalizeSiteHost(`${name}${dots}`)
        if (dots.length > 1) expect(host, `${name}${dots}`).toBeNull()
        else expect(host?.endsWith('.'), `${name}${dots}`).toBe(false)
      }
  })
})

// The addresses that the input schema of project.create refuses and accepts
// (packages/trpc/src/routers/project.test.ts): one rule for an address typed as a site and for
// an address a connection is made to.
describe('the address rule of project.create', () => {
  const classify = (text: string) => {
    const host = normalizeSiteHost(text)
    if (host === null) return null
    return siteAddressFamily(host) === 0 ? classifySiteHostName(host) : classifySiteAddress(host)
  }

  it.each([
    '0.0.0.0',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '[::]',
    '[fe80::1]',
    '[::ffff:127.0.0.1]',
    '[2001:db8::1]',
    'host.invalid',
    'site.onion',
    '-host',
  ])('refuses the reserved host %s in every environment', (text) => {
    expect(classify(text)).toBeNull()
  })

  it.each([
    'localhost',
    'host.localhost',
    'host.docker.internal',
    'wordpress',
    'wordpress.test',
    'printer.local',
    '127.0.0.1',
    '127.1',
    '0x7f000001',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '[::1]',
    '[fc00::1]',
  ])('accepts the local or private host %s outside production only', (text) => {
    const cls = classify(text)
    expect(cls).toBe('local')
    expect(isSiteAddressAllowed(cls, 'production')).toBe(false)
    expect(isSiteAddressAllowed(cls, 'development')).toBe(true)
    expect(isSiteAddressAllowed(cls, 'test')).toBe(true)
  })

  it.each(['example.ru', 'EXAMPLE.RU', 'пример.рф', 'example.ru.'])(
    'accepts the public host %s',
    (text) => {
      expect(classify(text)).toBe('public')
    },
  )
})
