import { parseRefusedSubnets } from '@repo/ip-address'
import { describe, expect, it } from 'vitest'

import { fakedGitlabCom, publicHostResolver } from './public-host.ts'

// The address of a git host (docs/plan/84-projects.md, §4.6): an own GitLab server or the host of
// a link that resolves to a private address is refused before any request.
const resolveTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

const refusedCode = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code,
  )

describe('publicHostResolver', () => {
  it('answers the first public address', async () => {
    const resolve = publicHostResolver({
      refusedSubnets: [],
      allowLoopback: false,
      resolve: resolveTo('203.0.113.7', '2001:db8::1'),
    })
    // 2001:db8::/32 is documentation, not public: the whole name is refused.
    expect(await refusedCode(resolve('git.example.ru'))).toBe('GIT_HOST_REFUSED')
    const one = publicHostResolver({
      refusedSubnets: [],
      allowLoopback: false,
      resolve: resolveTo('8.8.8.8'),
    })
    expect(await one('git.example.ru')).toBe('8.8.8.8')
  })

  it('refuses a private, link-local, loopback or the platform’s own address', async () => {
    for (const address of ['10.0.0.1', '192.168.1.5', '169.254.169.254', '127.0.0.1', '::1'])
      expect(
        await refusedCode(
          publicHostResolver({
            refusedSubnets: [],
            allowLoopback: false,
            resolve: resolveTo(address),
          })('git.example.ru'),
        ),
      ).toBe('GIT_HOST_REFUSED')
    const platform = publicHostResolver({
      refusedSubnets: parseRefusedSubnets('8.8.8.0/24')!,
      allowLoopback: false,
      resolve: resolveTo('8.8.8.8'),
    })
    expect(await refusedCode(platform('git.example.ru'))).toBe('GIT_HOST_REFUSED')
  })

  it('refuses a name with one private address among public ones, and a name that does not resolve', async () => {
    const mixed = publicHostResolver({
      refusedSubnets: [],
      allowLoopback: false,
      resolve: resolveTo('8.8.8.8', '10.0.0.1'),
    })
    expect(await refusedCode(mixed('git.example.ru'))).toBe('GIT_HOST_REFUSED')
    const none = publicHostResolver({
      refusedSubnets: [],
      allowLoopback: false,
      resolve: () => Promise.reject(new Error('ENOTFOUND')),
    })
    expect(await refusedCode(none('git.example.ru'))).toBe('GIT_HOST_REFUSED')
  })

  it('refuses an address literal as a host, and lets loopback through only when allowed', async () => {
    const resolve = publicHostResolver({
      refusedSubnets: [],
      allowLoopback: true,
      resolve: resolveTo('127.0.0.1'),
    })
    expect(await refusedCode(resolve('8.8.8.8'))).toBe('GIT_HOST_REFUSED')
    expect(await resolve('localhost')).toBe('127.0.0.1')
  })
})

describe('fakedGitlabCom', () => {
  it('pins gitlab.com to the host of the fake of a stand, and nothing else', async () => {
    const asked: string[] = []
    const resolve = async (host: string) => {
      asked.push(host)
      return host === 'localhost' ? '127.0.0.1' : '203.0.113.7'
    }
    const faked = fakedGitlabCom(resolve, 'https://localhost:41234')
    expect(await faked('gitlab.com')).toBe('127.0.0.1')
    expect(await faked('git.example.ru')).toBe('203.0.113.7')
    expect(asked).toEqual(['localhost', 'git.example.ru'])
    // Without the fake — every name as it is.
    expect(fakedGitlabCom(resolve, undefined)).toBe(resolve)
  })
})
