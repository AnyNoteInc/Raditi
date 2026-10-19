import { afterEach, describe, expect, it, vi } from 'vitest'

import { HostLookupError, isHostLookupError, siteConnectionLimits } from '@repo/domain'

import { createHostLookup, createLookupWith, type ResolverLike } from './lookup.ts'

type Answer = string[] | NodeJS.ErrnoException | 'never'

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`dns ${code}`), { code })
}

/** A scripted resolver: each family answers on the next tick, or never. */
function scripted(answers: { 4: Answer; 6: Answer }) {
  const asked: string[] = []
  const pending: Array<() => void> = []
  let cancelled = 0
  const query =
    (family: 4 | 6) =>
    (name: string, callback: (error: NodeJS.ErrnoException | null, list: string[]) => void) => {
      asked.push(`${family}:${name}`)
      const answer = answers[family]
      const fire = () =>
        answer instanceof Error ? callback(answer, []) : callback(null, answer as string[])
      if (answer === 'never') pending.push(() => callback(failure('ECANCELLED'), []))
      else queueMicrotask(fire)
    }
  const resolver: ResolverLike = {
    resolve4: query(4),
    resolve6: query(6),
    cancel() {
      cancelled += 1
      for (const fire of pending.splice(0)) fire()
    },
  }
  return { resolver, asked, cancelled: () => cancelled }
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (isHostLookupError(error)) return error.reason
    throw error
  }
  throw new Error('the lookup resolved')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createLookupWith', () => {
  it('asks A and AAAA of the name and returns both families', async () => {
    const fake = scripted({ 4: ['203.0.113.7'], 6: ['2001:db8::7'] })
    const lookup = createLookupWith(() => fake.resolver)
    await expect(lookup('example.com', new AbortController().signal)).resolves.toEqual([
      { address: '203.0.113.7', family: 4 },
      { address: '2001:db8::7', family: 6 },
    ])
    expect(fake.asked).toEqual(['4:example.com', '6:example.com'])
  })

  it('takes one family when the other has no record', async () => {
    const lookup = createLookupWith(() => scripted({ 4: failure('ENODATA'), 6: ['::1'] }).resolver)
    await expect(lookup('example.com', new AbortController().signal)).resolves.toEqual([
      { address: '::1', family: 6 },
    ])
  })

  it('answers not_found for NXDOMAIN and for a name without records', async () => {
    const nx = createLookupWith(
      () => scripted({ 4: failure('ENOTFOUND'), 6: failure('ENOTFOUND') }).resolver,
    )
    const empty = createLookupWith(() => scripted({ 4: failure('ENODATA'), 6: [] }).resolver)
    expect(await reason(nx('missing.example', new AbortController().signal))).toBe('not_found')
    expect(await reason(empty('empty.example', new AbortController().signal))).toBe('not_found')
  })

  it('fails as a timeout when one family fails, even if the other answered', async () => {
    for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED']) {
      const lookup = createLookupWith(
        () => scripted({ 4: ['203.0.113.7'], 6: failure(code) }).resolver,
      )
      expect(await reason(lookup('example.com', new AbortController().signal))).toBe('timeout')
    }
  })

  it('cancels its queries when the signal aborts', async () => {
    const fake = scripted({ 4: 'never', 6: 'never' })
    const lookup = createLookupWith(() => fake.resolver)
    const controller = new AbortController()
    const pending = lookup('slow.example', controller.signal)
    controller.abort()
    expect(await reason(pending)).toBe('timeout')
    expect(fake.cancelled()).toBeGreaterThan(0)
  })

  it('refuses at once with an aborted signal and asks nothing', async () => {
    const fake = scripted({ 4: ['203.0.113.7'], 6: [] })
    const controller = new AbortController()
    controller.abort()
    const lookup = createLookupWith(() => fake.resolver)
    expect(await reason(lookup('example.com', controller.signal))).toBe('timeout')
    expect(fake.asked).toEqual([])
  })

  it('gives up after dnsMs as a whole', async () => {
    vi.useFakeTimers()
    const fake = scripted({ 4: 'never', 6: ['::1'] })
    const lookup = createLookupWith(() => fake.resolver)
    const pending = reason(lookup('slow.example', new AbortController().signal))
    await vi.advanceTimersByTimeAsync(siteConnectionLimits.dnsMs - 1)
    expect(fake.cancelled()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe('timeout')
    expect(fake.cancelled()).toBe(1)
  })

  it('reads a synchronous refusal of the resolver as no such name', async () => {
    const resolver: ResolverLike = {
      resolve4() {
        throw new TypeError('bad name')
      },
      resolve6() {},
      cancel() {},
    }
    const lookup = createLookupWith(() => resolver)
    const error = await lookup('x', new AbortController().signal).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HostLookupError)
    expect((error as HostLookupError).reason).toBe('not_found')
  })
})

describe('createHostLookup', () => {
  it('builds a real resolver for the given servers without asking anything', () => {
    expect(typeof createHostLookup({ servers: ['192.0.2.53'] })).toBe('function')
    expect(() => createHostLookup({ servers: ['not an address'] })).toThrow()
  })
})
