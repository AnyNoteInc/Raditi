import { describe, expect, it, vi } from 'vitest'

import type { AppEnv } from '../app-env.ts'
import {
  HostLookupError,
  isHostLookupError,
  resolvePinnedAddress,
  tlsIdentity,
  type HostLookup,
  type LookedUpAddress,
} from './address.ts'
import {
  FileSourceGuardError,
  isFileSourceGuardError,
  isSiteConnectionError,
  SiteConnectionError,
} from './ports.ts'

const environments = ['development', 'test', 'production'] as const
const outsideProduction = ['development', 'test'] as const

const v4 = (address: string): LookedUpAddress => ({ address, family: 4 })
const v6 = (address: string): LookedUpAddress => ({ address, family: 6 })

function answering(...answer: LookedUpAddress[]) {
  return vi.fn<HostLookup>(async () => answer)
}
function failing(error: unknown) {
  return vi.fn<HostLookup>(async () => {
    throw error
  })
}
const resolve = (lookup: HostLookup, appEnv: AppEnv, host: string, signal?: AbortSignal) =>
  resolvePinnedAddress({ lookup, appEnv }, host, signal ?? new AbortController().signal)

describe('resolvePinnedAddress', () => {
  describe.each(environments)('an IP literal with APP_ENV=%s', (appEnv) => {
    it.each([
      ['8.8.8.8', 4],
      ['2a02:6b8::2:242', 6],
    ] as const)('pins the public literal %s without a query', async (host, family) => {
      const lookup = answering(v4('127.0.0.1'))
      const result = await resolve(lookup, appEnv, host)
      expect(result).toEqual({ ok: true, address: { host, address: host, family, isName: false } })
      expect(lookup).not.toHaveBeenCalled()
    })

    it.each([
      '0.0.0.0',
      '169.254.169.254',
      '100.64.0.1',
      '224.0.0.1',
      '::',
      'fe80::1',
      '::ffff:7f00:1',
      '64:ff9b::808:808',
      '2001:db8::1',
      '2002::1',
    ])('refuses the reserved literal %s without a query', async (host) => {
      const lookup = answering(v4('8.8.8.8'))
      expect(await resolve(lookup, appEnv, host)).toEqual({
        ok: false,
        reason: 'address_not_allowed',
      })
      expect(lookup).not.toHaveBeenCalled()
    })
  })

  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.10', '::1', 'fc00::1'])(
    'pins the local literal %s outside production only',
    async (host) => {
      const lookup = answering(v4('8.8.8.8'))
      for (const appEnv of outsideProduction) {
        const result = await resolve(lookup, appEnv, host)
        expect(result).toMatchObject({ ok: true, address: { host, address: host, isName: false } })
      }
      expect(await resolve(lookup, 'production', host)).toEqual({
        ok: false,
        reason: 'address_not_allowed',
      })
      expect(lookup).not.toHaveBeenCalled()
    },
  )

  it.each(environments)(
    'refuses a name the rule never accepts without a query (%s)',
    async (appEnv) => {
      const lookup = answering(v4('8.8.8.8'))
      for (const host of [
        'host.invalid',
        'site.onion',
        '-host',
        'exa_mple.ru',
        'a..b',
        '',
        '127.1',
        '1.2.3',
      ])
        expect(await resolve(lookup, appEnv, host)).toEqual({
          ok: false,
          reason: 'address_not_allowed',
        })
      expect(lookup).not.toHaveBeenCalled()
    },
  )

  it.each([
    'wordpress',
    'localhost',
    'app.localhost',
    'db.internal',
    'host.docker.internal',
    'printer.local',
    'site.test',
    'nas.lan',
    'router.home',
  ])('refuses the single label or local zone %s in production without a query', async (host) => {
    // No query: such a name cannot be used to probe the resolver of the platform's network.
    const lookup = answering(v4('8.8.8.8'))
    expect(await resolve(lookup, 'production', host)).toEqual({
      ok: false,
      reason: 'address_not_allowed',
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each(outsideProduction)('pins localhost to loopback without a query (%s)', async (appEnv) => {
    // An answer that would send the connection elsewhere, if anybody asked.
    const lookup = answering(v4('8.8.8.8'))
    for (const host of ['localhost', 'app.localhost', 'LOCALHOST'])
      expect(await resolve(lookup, appEnv, host)).toEqual({
        ok: true,
        address: { host, address: '127.0.0.1', family: 4, isName: true },
      })
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each(outsideProduction)('looks a local name up outside production (%s)', async (appEnv) => {
    const lookup = answering(v4('172.18.0.5'))
    const signal = new AbortController().signal
    expect(await resolve(lookup, appEnv, 'wordpress.test', signal)).toEqual({
      ok: true,
      address: { host: 'wordpress.test', address: '172.18.0.5', family: 4, isName: true },
    })
    expect(lookup).toHaveBeenCalledExactlyOnceWith('wordpress.test', signal)
  })

  it.each(environments)('looks a public name up once and pins its address (%s)', async (appEnv) => {
    const lookup = answering(v4('77.88.55.88'))
    const signal = new AbortController().signal
    const result = await resolve(lookup, appEnv, 'example.ru', signal)
    expect(result).toEqual({
      ok: true,
      address: { host: 'example.ru', address: '77.88.55.88', family: 4, isName: true },
    })
    expect(lookup).toHaveBeenCalledExactlyOnceWith('example.ru', signal)
    expect(result.ok && Object.isFrozen(result.address)).toBe(true)
  })

  it('dials the first IPv4 address, else the first IPv6 address', async () => {
    const both = answering(v6('2a02:6b8::1'), v4('77.88.55.88'), v4('77.88.55.60'))
    expect(await resolve(both, 'production', 'example.ru')).toMatchObject({
      address: { address: '77.88.55.88', family: 4 },
    })
    const onlyV6 = answering(v6('2a02:6b8::1'), v6('2a02:6b8::2'))
    expect(await resolve(onlyV6, 'production', 'example.ru')).toMatchObject({
      address: { address: '2a02:6b8::1', family: 6 },
    })
  })

  it('reads the family from the literal, not from what the lookup says about it', async () => {
    const lookup = answering({ address: '2a02:6b8::1', family: 4 })
    expect(await resolve(lookup, 'production', 'example.ru')).toMatchObject({
      address: { address: '2a02:6b8::1', family: 6 },
    })
  })

  it('answers host_not_found for a name that does not exist or has no address', async () => {
    for (const appEnv of environments) {
      expect(
        await resolve(failing(new HostLookupError('not_found')), appEnv, 'example.ru'),
      ).toEqual({
        ok: false,
        reason: 'host_not_found',
      })
      expect(await resolve(answering(), appEnv, 'example.ru')).toEqual({
        ok: false,
        reason: 'host_not_found',
      })
    }
  })

  it('answers unreachable for a lookup that timed out or failed in any other way', async () => {
    const thrower: HostLookup = () => {
      throw new Error('not even a promise')
    }
    for (const lookup of [
      failing(new HostLookupError('timeout')),
      failing(new Error('SERVFAIL')),
      failing(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })),
      failing('text'),
      failing(undefined),
      thrower,
    ])
      expect(await resolve(lookup, 'production', 'example.ru')).toEqual({
        ok: false,
        reason: 'unreachable',
      })
  })

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a bare address', '8.8.8.8'],
    ['one record outside a list', v4('8.8.8.8')],
    ['a list with a hole', [null]],
    ['a record without an address', [{}]],
    ['an address that is not text', [{ address: 5, family: 4 }]],
    ['a broken record after a good one', [v4('8.8.8.8'), null]],
  ])('answers unreachable for a lookup that breaks its type with %s', async (_what, answer) => {
    // Never rejects: a caller has no `try` around it, and a TypeError there is an unmapped failure.
    const lookup = vi.fn(async () => answer) as unknown as HostLookup
    for (const appEnv of environments)
      expect(await resolve(lookup, appEnv, 'example.ru')).toEqual({
        ok: false,
        reason: 'unreachable',
      })
  })

  it('reads each address of an answer once', async () => {
    let reads = 0
    const record = {
      family: 4 as const,
      get address() {
        reads += 1
        return reads === 1 ? '77.88.55.88' : '127.0.0.1'
      },
    }
    // What was classified is what is dialled: a second read could name another address.
    expect(await resolve(answering(record), 'production', 'example.ru')).toMatchObject({
      ok: true,
      address: { address: '77.88.55.88', family: 4 },
    })
    expect(reads).toBe(1)
  })

  it('does not look up after the deadline', async () => {
    const lookup = answering(v4('77.88.55.88'))
    expect(await resolve(lookup, 'production', 'example.ru', AbortSignal.abort())).toEqual({
      ok: false,
      reason: 'unreachable',
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('stops waiting when the signal aborts, even for a lookup that ignores it', async () => {
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    const lookup = vi.fn<HostLookup>(() => new Promise(() => {}))
    const result = resolve(lookup, 'production', 'example.ru', controller.signal)
    await Promise.resolve()
    controller.abort()
    expect(await result).toEqual({ ok: false, reason: 'unreachable' })
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('leaves no listener on the signal after an answer or a failure', async () => {
    const thrower: HostLookup = () => {
      throw new Error('not even a promise')
    }
    for (const [lookup, listeners] of [
      [answering(v4('77.88.55.88')), 1],
      [failing(new HostLookupError('not_found')), 1],
      [thrower, 0],
    ] as const) {
      const controller = new AbortController()
      const added = vi.spyOn(controller.signal, 'addEventListener')
      const removed = vi.spyOn(controller.signal, 'removeEventListener')
      await resolve(lookup, 'production', 'example.ru', controller.signal)
      expect(added).toHaveBeenCalledTimes(listeners)
      expect(removed.mock.calls).toEqual(
        added.mock.calls.map(([type, listener]) => [type, listener]),
      )
    }
  })

  describe('every address of the answer must be allowed', () => {
    it.each([
      ['a loopback record', [v4('77.88.55.88'), v4('127.0.0.1')]],
      ['a private record', [v4('77.88.55.88'), v4('10.0.0.5'), v4('77.88.55.60')]],
      ['a private record first', [v4('192.168.1.10'), v4('77.88.55.88')]],
      ['a unique local IPv6 record', [v4('77.88.55.88'), v6('fd00::1')]],
      ['a link-local record', [v4('77.88.55.88'), v4('169.254.169.254')]],
      ['an IPv4-mapped record', [v4('77.88.55.88'), v6('::ffff:127.0.0.1')]],
      ['a NAT64 record', [v6('64:ff9b::7f00:1'), v4('77.88.55.88')]],
      ['only private records', [v4('10.0.0.5')]],
      ['something that is not an address', [v4('77.88.55.88'), v4('internal.example.ru')]],
      ['an empty address', [v4('77.88.55.88'), v4('')]],
    ])('production answers host_not_found for a public name with %s', async (_what, answer) => {
      const result = await resolve(answering(...answer), 'production', 'example.ru')
      // The same answer as for a name that does not exist: no map of internal names.
      const missing = await resolve(
        failing(new HostLookupError('not_found')),
        'production',
        'example.ru',
      )
      expect(result).toEqual({ ok: false, reason: 'host_not_found' })
      expect(result).toEqual(missing)
    })

    it.each(outsideProduction)(
      'a reserved record refuses the name outside production (%s)',
      async (appEnv) => {
        for (const answer of [
          [v4('77.88.55.88'), v4('169.254.169.254')],
          [v4('77.88.55.88'), v6('::ffff:127.0.0.1')],
          [v4('0.0.0.0')],
          [v4('77.88.55.88'), v4('not an address')],
        ])
          expect(await resolve(answering(...answer), appEnv, 'example.ru')).toEqual({
            ok: false,
            reason: 'address_not_allowed',
          })
      },
    )

    it.each(outsideProduction)(
      'a private record is a local site outside production (%s)',
      async (appEnv) => {
        const lookup = answering(v6('fd00::1'), v4('10.0.0.5'), v4('77.88.55.88'))
        expect(await resolve(lookup, appEnv, 'example.ru')).toMatchObject({
          ok: true,
          address: { address: '10.0.0.5', family: 4, isName: true },
        })
      },
    )
  })
})

describe('tlsIdentity', () => {
  const pinned = async (host: string, lookup: HostLookup = answering(v4('127.0.0.1'))) => {
    const result = await resolve(lookup, 'test', host)
    if (!result.ok) throw new Error(`not pinned: ${result.reason}`)
    return result.address
  }

  it('names the server by its name when a name was typed', async () => {
    expect(tlsIdentity(await pinned('db.example.ru'))).toEqual({ servername: 'db.example.ru' })
    expect(tlsIdentity(await pinned('localhost'))).toEqual({ servername: 'localhost' })
  })

  it('names the literal when an address was typed, so no default name is checked instead', async () => {
    expect(tlsIdentity(await pinned('127.0.0.1'))).toEqual({ host: '127.0.0.1' })
    expect(tlsIdentity(await pinned('::1'))).toEqual({ host: '::1' })
  })

  it('never names the address a name resolved to', async () => {
    // A name that exists in no resolver of the machine, reached on loopback: how the adapters'
    // tests prove that only the pinned literal is dialled.
    const address = await pinned('files.hosting.example', answering(v4('127.0.0.1')))
    expect(address).toMatchObject({ host: 'files.hosting.example', address: '127.0.0.1' })
    expect(tlsIdentity(address)).toEqual({ servername: 'files.hosting.example' })
  })
})

describe('error classes of the site connection', () => {
  it('carry their name and what the caller maps', () => {
    const lookup = new HostLookupError('timeout')
    expect(lookup).toBeInstanceOf(Error)
    expect(lookup).toMatchObject({ name: 'HostLookupError', reason: 'timeout' })
    expect(lookup.message).toBe('Host lookup: timeout')

    const connection = new SiteConnectionError('auth_failed')
    expect(connection).toBeInstanceOf(Error)
    expect(connection).toMatchObject({ name: 'SiteConnectionError', reason: 'auth_failed' })
    expect(connection.message).toBe('Site connection: auth_failed')

    const guard = new FileSourceGuardError('outside_root')
    expect(guard).toBeInstanceOf(Error)
    expect(guard).toMatchObject({ name: 'FileSourceGuardError', guard: 'outside_root' })
    expect(guard.message).toBe('File source guard: outside_root')
  })

  it('are recognised by name, across duplicated module instances', () => {
    const guards = [
      ['HostLookupError', isHostLookupError, new HostLookupError('not_found')],
      ['SiteConnectionError', isSiteConnectionError, new SiteConnectionError('transfer_failed')],
      ['FileSourceGuardError', isFileSourceGuardError, new FileSourceGuardError('bytes')],
    ] as const
    for (const [name, guard, own] of guards) {
      expect(guard(own)).toBe(true)
      // What another copy of the package would throw: the same name, another class.
      expect(guard(Object.assign(new Error('copy'), { name }))).toBe(true)
      for (const other of guards) if (other[0] !== name) expect(guard(other[2])).toBe(false)
      for (const value of [new Error(name), new TypeError('x'), { name }, name, null, undefined])
        expect(guard(value)).toBe(false)
    }
  })
})
