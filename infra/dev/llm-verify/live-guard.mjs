// The hard cap of a live run on requests to the real provider. Loaded with `--import` into every
// process of the stand that can reach the provider (the role llm, the trusted core worker, the
// operator's login command) and imported by the stand process itself:
//   node --import 'file:///…/live-guard.mjs?ledger=<file>&cap=<n>&host=<name>&port=<n>' …
// The address comes from guardImport() of live.mjs and holds no secret.
//
// `net.Socket#connect` is replaced; through it pass node:net, node:tls, node:http, node:https,
// node:http2, fetch and WebSocket. A connection of the process is then one of three things:
//   - to this machine (a local socket, a loopback address): passed on, not counted;
//   - to the provider, exactly `host:port`: written to the ledger first and opened only if its
//     place among the provider connections of the whole run is not above the cap;
//   - to anything else: refused before a packet leaves, and named in the ledger.
// The role llm opens a connection of its own for every request it sends (a generation, a quota
// probe), so the ledger counts provider requests, and a request that would be one too many never
// leaves the machine whatever asked for it: a CLI that repeats, a model that loops, a role that
// lost its own limits. The ledger is one file shared by the processes of a run; a line is
// appended whole (O_APPEND), and its place in the file is the order every process agrees on. A
// guard that cannot write its ledger opens no provider connection at all.
//
// Outside the guard: UDP, `dns.resolve*`, worker threads and child processes started without
// `--import`. The role llm and the operator command start none.
//
// Ledger lines: `<kind> <pid> <ms> <seq> [host:port]`; kinds: `a` an attempt (its place is the
// order), `c` a connection let through, `r` one refused over the cap, `f` one to another host.
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import process from 'node:process'

const parameters = new URL(import.meta.url).searchParams
const ledger = parameters.get('ledger') ?? ''
const cap = Number(parameters.get('cap') ?? Number.NaN)
const providerHost = (parameters.get('host') ?? '').toLowerCase()
const providerPort = Number(parameters.get('port') ?? Number.NaN)
if (
  !ledger.startsWith('/') ||
  !Number.isInteger(cap) ||
  cap < 0 ||
  !/^[a-z0-9.-]+$/.test(providerHost) ||
  !Number.isInteger(providerPort) ||
  providerPort < 1 ||
  providerPort > 65_535
)
  // The process does not start unguarded on a mistyped address.
  throw new Error('Live guard: invalid address')

const marker = Symbol.for('raditi.live-guard')
const normalized = (host) =>
  typeof host === 'string'
    ? host
        .toLowerCase()
        .replace(/^\[(.*)\]$/, '$1')
        .replace(/\.$/, '')
    : host
const loopback = (host) =>
  host === undefined ||
  host === null ||
  (typeof host === 'string' &&
    (['', 'localhost', '::1', '::', '0.0.0.0', '::ffff:127.0.0.1'].includes(host) ||
      /^127(?:\.\d{1,3}){3}$/.test(host)))
const refusal = (code, message) => Object.assign(new Error(`Live guard: ${message}`), { code })

let sequence = 0
function append(kind, id, target) {
  const descriptor = openSync(ledger, 'a', 0o600)
  try {
    writeSync(
      descriptor,
      `${kind} ${process.pid} ${Date.now()} ${id}${target ? ` ${target}` : ''}\n`,
    )
  } finally {
    closeSync(descriptor)
  }
}

/** Whether this provider connection is within the cap of the run; the ledger says so first. */
function admitted() {
  const id = ++sequence
  try {
    if (cap === 0) {
      append('r', id)
      return false
    }
    append('a', id)
    const own = `a ${process.pid} `
    let place = 0
    for (const line of readFileSync(ledger, 'utf8').split('\n')) {
      if (!line.startsWith('a ')) continue
      place += 1
      if (line.startsWith(own) && line.endsWith(` ${id}`)) break
    }
    const within = place >= 1 && place <= cap
    append(within ? 'c' : 'r', id)
    return within
  } catch {
    // No ledger, no connection.
    return false
  }
}

function install() {
  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function guardedConnect(...args) {
    // net hands its own normalized arguments over as one array.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]
    let host
    let port
    let path
    if (first !== null && typeof first === 'object') ({ host, port, path } = first)
    else if (typeof first === 'string' && Number.isNaN(Number(first))) path = first
    else {
      port = first
      host = typeof args[1] === 'string' ? args[1] : undefined
    }
    // A local socket by its path: the agents of node:http hand every connection over with
    // `path: null`, and only a path that names a socket is one.
    if (typeof path === 'string' && path !== '') return Reflect.apply(connect, this, args)
    const name = normalized(host)
    let error
    if (name === providerHost && Number(port) === providerPort) {
      if (admitted()) return Reflect.apply(connect, this, args)
      error = refusal('ERR_LIVE_BUDGET', 'the request budget of the run is spent')
    } else if (loopback(name)) return Reflect.apply(connect, this, args)
    else {
      try {
        append('f', ++sequence, `${String(name).slice(0, 255)}:${Number(port) || 0}`)
      } catch {
        /* Refused either way. */
      }
      error = refusal('ERR_LIVE_FOREIGN_HOST', 'a connection outside the provider was refused')
    }
    process.nextTick(() => this.destroy(error))
    return this
  }
  // Named imports of node:net see the guarded function as well.
  syncBuiltinESMExports()
  return { ledger, cap, host: providerHost, port: providerPort }
}

// One guard a process: a second import with another address must not loosen the first.
const installed = (globalThis[marker] ??= install())
if (
  installed.ledger !== ledger ||
  installed.cap !== cap ||
  installed.host !== providerHost ||
  installed.port !== providerPort
)
  throw new Error('Live guard: already installed with another address')
