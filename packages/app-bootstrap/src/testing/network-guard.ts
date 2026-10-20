import dns from 'node:dns'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import process from 'node:process'

/**
 * The process this file is loaded into opens no TCP connection and resolves no name with
 * `dns.lookup` outside this machine: `net.Socket#connect` is replaced, and through it pass
 * node:net, node:tls, node:http, node:https, node:http2, fetch and WebSocket. Loaded before
 * every test file of Vitest (`setupFiles`, network-guard.setup.ts) and, by `--import`, before
 * the commands a test starts as processes of their own. A test of the way to a provider that
 * has lost its rule then fails here instead of reaching the provider: the guarantee does not
 * rest on every test pointing every declared origin at a loopback address
 * (docs/plan/43-zai-gateway-stand.md, «Инцидент»).
 *
 * Outside the guard: `dns.resolve*` and `dns.Resolver`, UDP, worker threads, child processes
 * started without `--import` (git, docker) and the `node --test` tests of scripts/.
 *
 * A refusal fails the test of the Vitest process that made it (network-guard.setup.ts). A
 * command's own list dies with its process: loaded as `<this file's URL>?report=<file>`, the
 * guard also appends every refusal to that file as a line, for the test that started the
 * command.
 *
 * Erasable syntax only: Node loads this file as it is.
 */
export interface NetworkGuardViolation {
  kind: 'connect' | 'lookup'
  host: string
}

interface NetworkGuard {
  violations: NetworkGuardViolation[]
}

const key = Symbol.for('raditi.test-network-guard')
const globals = globalThis as { [key]?: NetworkGuard }

const loopback = (host: unknown): boolean =>
  host === undefined ||
  host === null ||
  (typeof host === 'string' &&
    (['', 'localhost', '::1', '[::1]', '::', '0.0.0.0', '::ffff:127.0.0.1'].includes(host) ||
      /^127(?:\.\d{1,3}){3}$/.test(host)))

const refused = (violation: NetworkGuardViolation): Error =>
  Object.assign(new Error(`Test network guard: ${violation.kind} to ${violation.host} refused`), {
    code: 'ERR_TEST_NETWORK_GUARD',
  })

function install(): NetworkGuard {
  const guard: NetworkGuard = { violations: [] }
  const report = new URL(import.meta.url).searchParams.get('report')
  const refuse = (kind: NetworkGuardViolation['kind'], host: unknown): Error => {
    const violation = { kind, host: String(host) }
    guard.violations.push(violation)
    if (report) appendFileSync(report, `${JSON.stringify(violation)}\n`)
    return refused(violation)
  }

  const lookup = dns.lookup as (...args: unknown[]) => unknown
  dns.lookup = function guardedLookup(this: unknown, ...args: unknown[]): unknown {
    if (loopback(args[0])) return Reflect.apply(lookup, this, args)
    const error = refuse('lookup', args[0])
    const callback = args.at(-1)
    if (typeof callback === 'function')
      process.nextTick(() => Reflect.apply(callback, null, [error]))
    return {}
  } as unknown as typeof dns.lookup
  const promisesLookup = dns.promises.lookup as (...args: unknown[]) => Promise<unknown>
  dns.promises.lookup = function guardedLookup(this: unknown, ...args: unknown[]) {
    if (loopback(args[0])) return Reflect.apply(promisesLookup, this, args)
    return Promise.reject(refuse('lookup', args[0]))
  } as unknown as typeof dns.promises.lookup

  const connect = net.Socket.prototype.connect as (...args: unknown[]) => net.Socket
  net.Socket.prototype.connect = function guardedConnect(
    this: net.Socket,
    ...args: unknown[]
  ): net.Socket {
    // net hands its own normalized arguments over as one array.
    const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0]
    let host: unknown
    let path: unknown
    if (first !== null && typeof first === 'object')
      ({ host, path } = first as Record<string, unknown>)
    else if (typeof first === 'string' && Number.isNaN(Number(first))) path = first
    else host = typeof args[1] === 'string' ? args[1] : undefined
    // A local socket by its path, or an address of this machine. The agents of node:http hand
    // every connection over with `path: null`: only a path that names a socket is one.
    if ((typeof path === 'string' && path !== '') || loopback(host))
      return Reflect.apply(connect, this, args)
    const error = refuse('connect', host)
    process.nextTick(() => this.destroy(error))
    return this
  } as typeof net.Socket.prototype.connect

  // Named imports of the two modules see the guarded functions as well.
  syncBuiltinESMExports()
  return guard
}

const guard = (globals[key] ??= install())

/** What the guard has refused since the last call; taking the list empties it. */
export const takeNetworkGuardViolations = (): NetworkGuardViolation[] => guard.violations.splice(0)
