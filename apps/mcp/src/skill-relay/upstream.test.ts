import { readFileSync } from 'node:fs'

import { SKILL_RELAY_PATH } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { RelayRefusal, upstreamResolver } from './upstream.ts'

const resolver = (addresses: string[], options: { allowLoopback?: boolean } = {}) =>
  upstreamResolver({
    refusedSubnets: [{ address: '45.8.250.0', prefix: 24, family: 4 }],
    allowLoopback: options.allowLoopback ?? false,
    resolve: async () =>
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  })

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof RelayRefusal ? error.code : 'other'),
  )

describe('upstreamResolver', () => {
  it('connects to a public address the name resolves to', async () => {
    expect(await resolver(['93.184.216.34'])(new URL('https://mcp.example.com/mcp'))).toEqual({
      address: '93.184.216.34',
      family: 4,
    })
  })

  it('refuses a name with any address that is not public, and the platform itself', async () => {
    for (const addresses of [
      ['93.184.216.34', '10.0.0.1'],
      ['169.254.169.254'],
      ['45.8.250.117'],
      ['::1'],
    ])
      expect(
        await refusal(resolver(addresses)(new URL('https://mcp.example.com/mcp'))),
        String(addresses),
      ).toBe('address_refused')
    expect(await refusal(resolver([])(new URL('https://mcp.example.com/mcp')))).toBe('unreachable')
  })

  it('takes a loopback server only where the configuration lets a test have one', async () => {
    const url = new URL('https://localhost/mcp')
    expect(await refusal(resolver(['127.0.0.1'])(url))).toBe('address_refused')
    expect(await resolver(['127.0.0.1'], { allowLoopback: true })(url)).toEqual({
      address: '127.0.0.1',
      family: 4,
    })
  })
})

describe('the hosts of a stand', () => {
  it('answers a name of a stand by its loopback address and port, without DNS', async () => {
    const resolve = upstreamResolver({
      refusedSubnets: [],
      allowLoopback: true,
      hosts: { 'mcp.relay-stand.example': { address: '127.0.0.1', port: 45123 } },
      resolve: async () => {
        throw new Error('no DNS for a stand')
      },
    })
    expect(await resolve(new URL('https://mcp.relay-stand.example:8443/mcp'))).toEqual({
      address: '127.0.0.1',
      family: 4,
      port: 45123,
    })
  })
})

describe('the path of the relay', () => {
  it('is the same on the gateway of a sandbox as in the domain', () => {
    const gateway = readFileSync(
      new URL('../../../../infra/sandbox/gateway.mjs', import.meta.url),
      'utf8',
    )
    const written = /export const skillRelayPath = (\/.+\/)\n/.exec(gateway)?.[1]
    expect(written).toBe(
      String(SKILL_RELAY_PATH).replace(
        '([a-z](?:[a-z0-9-]{0,30}[a-z0-9])?)',
        '[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?',
      ),
    )
  })
})
