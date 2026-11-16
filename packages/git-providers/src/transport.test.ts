import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DomainError, gitHostRefused } from '@repo/domain'

import { fakeSend } from './testing/fake-send.ts'
import { createGitTransport, pinnedLookup } from './transport.ts'

const code = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  return 'no error'
}

describe('transport', () => {
  it('resolves a host once per operation and refuses before the network', async () => {
    const { send, calls } = fakeSend({ 'GET /x': { status: 200, body: {} } })
    const resolvePublic = vi.fn(async (host: string) => {
      if (host === 'gitlab.internal.example') throw gitHostRefused()
      return '203.0.113.9'
    })
    const transport = createGitTransport({ resolvePublic, send })
    const session = transport.session()
    await session.request({ method: 'GET', url: new URL('https://gitlab.example.ru/x') })
    await session.request({ method: 'GET', url: new URL('https://gitlab.example.ru/x') })
    expect(resolvePublic).toHaveBeenCalledTimes(1)
    expect(
      await code(
        transport
          .session()
          .request({ method: 'GET', url: new URL('https://gitlab.internal.example/x') }),
      ),
    ).toBe('GIT_HOST_REFUSED')
    expect(calls).toHaveLength(2)
  })

  it.each([
    'http://gitlab.example.ru/x',
    'https://gitlab.example.ru:8443/x',
    'https://user:pw@gitlab.example.ru/x',
  ])('refuses %s', async (address) => {
    const { send, calls } = fakeSend({})
    const resolvePublic = vi.fn(async () => '203.0.113.9')
    const transport = createGitTransport({ resolvePublic, send })
    expect(await code(transport.session().request({ method: 'GET', url: new URL(address) }))).toBe(
      'GIT_HOST_REFUSED',
    )
    expect(resolvePublic).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('the lookup of a socket answers with the pinned address whatever the name', () => {
    const lookup = pinnedLookup('203.0.113.9') as unknown as (
      host: string,
      options: { all?: boolean },
      callback: (...args: unknown[]) => void,
    ) => void
    const one = vi.fn()
    lookup('gitlab.example.ru', {}, one)
    expect(one).toHaveBeenCalledWith(null, '203.0.113.9', 4)
    const all = vi.fn()
    lookup('gitlab.example.ru', { all: true }, all)
    expect(all).toHaveBeenCalledWith(null, [{ address: '203.0.113.9', family: 4 }])
    const six = vi.fn()
    ;(pinnedLookup('2001:db8::1') as unknown as typeof lookup)('h', {}, six)
    expect(six).toHaveBeenCalledWith(null, '2001:db8::1', 6)
  })

  it('never follows a redirect', async () => {
    const { send } = fakeSend({
      'GET /x': { status: 302, headers: { location: 'https://10.0.0.1/' } },
    })
    const transport = createGitTransport({ resolvePublic: async () => '203.0.113.9', send })
    expect(
      await code(
        transport.session().request({ method: 'GET', url: new URL('https://gitlab.example.ru/x') }),
      ),
    ).toBe('GIT_PROVIDER_FAILED')
  })
})

// The real sender over TLS on loopback: the name stays gitlab.example.ru for TLS and Host, the
// socket goes to the pinned address. Needs openssl for a throwaway certificate; skipped without it.
const openssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!openssl)('the TLS sender', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-transport-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reads a stand fake with its CA, keeps only a tail, bounds size and time', async () => {
    const seen: (string | undefined)[] = []
    const local = selfSigned(dir, 'localhost')
    const other = selfSigned(dir, 'gitlab.example.ru')
    const server = createServer({ key: local.key, cert: local.cert }, (req, res) => {
      seen.push(req.headers.host)
      if (req.url === '/big') res.end('x'.repeat(10_000) + 'TAIL')
      else if (req.url !== '/slow') res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const url = (path: string) => new URL(`https://localhost:${port}${path}`)
    try {
      const transport = createGitTransport({
        resolvePublic: async () => '127.0.0.1',
        ca: local.cert,
        timeoutMs: 500,
      })
      const ok = await transport.session().request({ method: 'GET', url: url('/ok') })
      expect(JSON.parse(ok.body.toString())).toEqual({ ok: true })
      expect(seen.at(-1)).toBe(`localhost:${port}`)
      const tail = await transport
        .session()
        .request({ method: 'GET', url: url('/big') }, { tailBytes: 4, maxBytes: 1 << 20 })
      expect(tail.body.toString()).toBe('TAIL')
      expect(tail.truncated).toBe(true)
      expect(
        await code(
          transport.session().request({ method: 'GET', url: url('/big') }, { maxBytes: 100 }),
        ),
      ).toBe('GIT_PROVIDER_FAILED')
      expect(await code(transport.session().request({ method: 'GET', url: url('/slow') }))).toBe(
        'GIT_PROVIDER_FAILED',
      )
      // A CA of another name: TLS checks the host name, so the pinned address does not help.
      const wrong = createGitTransport({
        resolvePublic: async () => '127.0.0.1',
        ca: other.cert,
        timeoutMs: 500,
      })
      expect(await code(wrong.session().request({ method: 'GET', url: url('/ok') }))).toBe(
        'GIT_PROVIDER_FAILED',
      )
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

function selfSigned(dir: string, name: string): { key: Buffer; cert: string } {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${name}`,
      '-addext',
      `subjectAltName=DNS:${name}`,
      '-keyout',
      join(dir, `${name}.key`),
      '-out',
      join(dir, `${name}.pem`),
    ],
    { stdio: 'ignore' },
  )
  return {
    key: readFileSync(join(dir, `${name}.key`)),
    cert: readFileSync(join(dir, `${name}.pem`), 'utf8'),
  }
}
