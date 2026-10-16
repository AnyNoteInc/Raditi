import { spawn } from 'node:child_process'
import dns from 'node:dns'
import { lookup as promisedLookup } from 'node:dns/promises'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net, { connect, createServer, type AddressInfo, type LookupFunction } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'

import { describe, expect, it } from 'vitest'

import type { NetworkGuardViolation } from './network-guard.ts'

// The guard is not imported here: this file meets it the way every other test file does, put
// in place by the setup of the test run. 203.0.113.0/24 is documentation space (RFC 5737) and
// `.invalid` never resolves (RFC 2606); were the guard missing, the first assertion of each
// test stops it before anything is tried.
const guard = () =>
  (globalThis as Record<symbol, unknown>)[Symbol.for('raditi.test-network-guard')] as
    { violations: NetworkGuardViolation[] } | undefined
const installed = () =>
  guard() !== undefined && net.Socket.prototype.connect.name === 'guardedConnect'
const takeNetworkGuardViolations = () => guard()!.violations.splice(0)
const failure = async (socket: net.Socket) => ((await once(socket, 'error')) as [Error])[0]

describe('the network guard of the orchestrator tests', () => {
  it('stands before every test file', () => {
    expect(installed()).toBe(true)
    expect(dns.lookup.name).toBe('guardedLookup')
    expect(takeNetworkGuardViolations()).toEqual([])
  })

  it('refuses a connection to any address or name that is not this machine', async () => {
    expect(installed()).toBe(true)
    for (const open of [
      () => connect({ host: '203.0.113.7', port: 443 }),
      () => connect(443, 'provider.invalid'),
      () => new net.Socket().connect({ host: 'provider.invalid', port: 443 }),
      () => tlsConnect({ host: 'provider.invalid', port: 443, servername: 'provider.invalid' }),
    ]) {
      const socket = open()
      expect(await failure(socket)).toMatchObject({ code: 'ERR_TEST_NETWORK_GUARD' })
      expect(socket.destroyed).toBe(true)
    }
    // Each attempt is kept for the hook that fails the test which made it.
    expect(takeNetworkGuardViolations()).toEqual([
      { kind: 'connect', host: '203.0.113.7' },
      { kind: 'connect', host: 'provider.invalid' },
      { kind: 'connect', host: 'provider.invalid' },
      { kind: 'connect', host: 'provider.invalid' },
    ])
  })

  it('refuses a request of node:http and node:https, whose agents hand net a null path', async () => {
    expect(installed()).toBe(true)
    // Were this rule lost, nothing would leave the machine either: the address is a spelling of
    // its loopback the guard does not know, and the caller's own lookup resolves the name to it.
    const address = '0:0:0:0:0:0:0:1'
    const own = ((_host, options, done) =>
      options.all
        ? done(null, [{ address: '127.0.0.1', family: 4 }])
        : done(null, '127.0.0.1', 4)) as LookupFunction
    for (const open of [
      () => http.request({ host: address, port: 9 }),
      () => http.request({ host: address, port: 9, agent: false }),
      () => http.request({ host: address, port: 9, agent: new http.Agent() }),
      // The shape of the role's way to its proxy.
      () => https.request({ host: address, port: 9, method: 'CONNECT', agent: false }),
      () => http.request({ host: 'provider.invalid', port: 9, lookup: own }),
      () => https.request({ host: 'provider.invalid', port: 9, agent: false, lookup: own }),
    ]) {
      const request = open()
      request.end()
      const [error] = (await once(request, 'error')) as [Error]
      expect(error).toMatchObject({ code: 'ERR_TEST_NETWORK_GUARD' })
    }
    expect(takeNetworkGuardViolations()).toEqual([
      ...Array.from({ length: 4 }, () => ({ kind: 'connect', host: address })),
      { kind: 'connect', host: 'provider.invalid' },
      { kind: 'connect', host: 'provider.invalid' },
    ])
  })

  it('reports what it refused in a process of its own to the file its starter names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'raditi-guard-'))
    try {
      const report = join(directory, 'refused')
      // The child swallows the refusal and exits with 0: only the report tells its starter.
      const script = `
        const net = require('node:net')
        if (net.Socket.prototype.connect.name !== 'guardedConnect') process.exit(3)
        net.connect({ host: '0:0:0:0:0:0:0:1', port: 9 }).on('error', () => {})`
      const guardFile = new URL('./network-guard.ts', import.meta.url)
      guardFile.searchParams.set('report', report)
      const child = spawn(process.execPath, ['--import', guardFile.href, '-e', script], {
        env: { PATH: process.env.PATH },
        stdio: 'ignore',
      })
      expect(await once(child, 'close')).toEqual([0, null])
      expect(await readFile(report, 'utf8')).toBe('{"kind":"connect","host":"0:0:0:0:0:0:0:1"}\n')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses to resolve such a name, also for a named import of the module', async () => {
    expect(installed()).toBe(true)
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      dns.lookup('provider.invalid', (failed) => resolve(failed)),
    )
    expect(error).toMatchObject({ code: 'ERR_TEST_NETWORK_GUARD' })
    await expect(promisedLookup('provider.invalid')).rejects.toMatchObject({
      code: 'ERR_TEST_NETWORK_GUARD',
    })
    expect(takeNetworkGuardViolations()).toEqual([
      { kind: 'lookup', host: 'provider.invalid' },
      { kind: 'lookup', host: 'provider.invalid' },
    ])
  })

  it('lets this machine through, by address and by name', async () => {
    const server = createServer((socket) => socket.end('ok'))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    try {
      for (const host of ['127.0.0.1', 'localhost']) {
        const socket = connect({ host, port })
        const [data] = (await once(socket, 'data')) as [Buffer]
        expect(data.toString()).toBe('ok')
        socket.destroy()
      }
      expect((await promisedLookup('localhost')).address).toMatch(/^(127\.0\.0\.1|::1)$/)
      expect(takeNetworkGuardViolations()).toEqual([])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('lets a request through an agent reach this machine, also by a socket path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'raditi-guard-'))
    const servers = [http.createServer(), http.createServer()].map((server) =>
      server.on('request', (_request, response) => response.end('ok')),
    )
    const status = async (options: http.RequestOptions) => {
      const request = http.get(options)
      const [response] = (await once(request, 'response')) as [http.IncomingMessage]
      response.resume()
      await once(response, 'end')
      return response.statusCode
    }
    try {
      const socketPath = join(directory, 'http.sock')
      await once(servers[0]!.listen(0, '127.0.0.1'), 'listening')
      await once(servers[1]!.listen(socketPath), 'listening')
      const { port } = servers[0]!.address() as AddressInfo
      expect(await status({ host: '127.0.0.1', port })).toBe(200)
      expect(await status({ host: 'localhost', port, agent: false })).toBe(200)
      expect(await status({ socketPath, agent: false })).toBe(200)
      expect(takeNetworkGuardViolations()).toEqual([])
    } finally {
      for (const server of servers) {
        server.closeAllConnections()
        server.close()
      }
      await rm(directory, { recursive: true, force: true })
    }
  })
})
