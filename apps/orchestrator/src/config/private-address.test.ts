import { describe, expect, it } from 'vitest'

import { ipLiteral, isLoopbackAddress, isPrivateAddress } from './private-address.ts'

describe('isPrivateAddress', () => {
  it.each([
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.10',
    'fd00::10',
    '[fd00::10]',
    'FC00::1',
    '::ffff:10.1.2.3',
    '[::ffff:192.168.1.1]',
    '::ffff:a01:203',
  ])('accepts the private literal %s', (host) => {
    expect(isPrivateAddress(host)).toBe(true)
  })

  it.each([
    'core.raditi.internal',
    'core.raditi.ru',
    'localhost',
    '8.8.8.8',
    '172.32.0.1',
    '172.15.255.255',
    '192.169.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fe80::1%eth0',
    '::ffff:8.8.8.8',
    '010.0.0.1',
    '10.1',
    '',
  ])('refuses %s', (host) => {
    expect(isPrivateAddress(host)).toBe(false)
  })
})

describe('ipLiteral', () => {
  it('gives one form of an address however it is written', () => {
    expect(ipLiteral('10.1.2.3')).toBe('10.1.2.3')
    expect(ipLiteral('::ffff:10.1.2.3')).toBe('10.1.2.3')
    expect(ipLiteral('[::FFFF:a01:203]')).toBe('10.1.2.3')
    expect(ipLiteral('[FD00:0:0::10]')).toBe('fd00::10')
    expect(ipLiteral('fd00:0000::0010')).toBe('fd00::10')
  })

  it('is undefined for names and malformed literals', () => {
    for (const host of ['core.internal', '10.1', '1.2.3.4.5', '[10.1.2.3]x', 'fe80::1%eth0'])
      expect(ipLiteral(host)).toBeUndefined()
  })
})

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1'])(
    'accepts the loopback literal %s',
    (host) => {
      expect(isLoopbackAddress(host)).toBe(true)
    },
  )

  it.each(['localhost', '10.0.0.1', '8.8.8.8', '::', '0.0.0.0', '128.0.0.1', ''])(
    'refuses %s',
    (host) => {
      expect(isLoopbackAddress(host)).toBe(false)
    },
  )
})
