/* global AbortSignal, fetch, structuredClone, URL */
// The regular role mcp of the agent-content stand and the stand's own look at its two sides.
//
// The role is the entry point of the build with the environment of one role and nothing else:
// the content profile of the configuration, Vault under the AppRole of the mcp service, its own
// S3 client. It listens on loopback, as every role does outside production. What the stand used
// to count inside its own composition of the role it now counts outside it: one proxy between
// sandbox-gw and the role, one between the role and the site. They keep protocol names, statuses
// and counters, never a credential, an argument or a response.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as createTcpServer, isIP } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const orchestrator = fileURLToPath(new URL('../', import.meta.url))
const LOOPBACK = '127.0.0.1'
const MAX_LOG_BYTES = 4 * 1024 * 1024
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_ENTRIES = 2000

/** A port nobody listens on at this moment, on loopback. */
export async function freePort() {
  const server = createTcpServer()
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * Everything the role process is given. Nothing of the launcher's environment is inherited, and
 * NODE_ENV is production for one reason: load-env.ts opens the repository .env otherwise, and a
 * stand never reads it. APP_ENV stays test — the content profile is refused in production.
 */
export function roleEnvironment({ path, home, port, allowedHosts, databaseUrl, vault, s3 }) {
  return {
    PATH: path,
    HOME: home,
    NODE_ENV: 'production',
    NO_COLOR: '1',
    APP_ENV: 'test',
    ORCHESTRATOR_ROLES: 'mcp',
    MCP_PORT: String(port),
    MCP_ALLOWED_HOSTS: allowedHosts.join(','),
    MCP_CONTENT_PROFILE: 'local',
    DATABASE_URL: databaseUrl,
    VAULT_ADDR: vault.address,
    VAULT_ROLE_ID: vault.roleId,
    VAULT_SECRET_ID: vault.secretId,
    S3_ENDPOINT: s3.endpoint,
    S3_REGION: s3.region,
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: s3.accessKey,
    S3_SECRET_ACCESS_KEY: s3.secretKey,
    S3_BUCKET_ARTIFACTS: s3.buckets.artifacts,
  }
}

/**
 * Starts `node dist/main.js` and waits for /health. The returned object has the shape of the
 * stand's other role processes: `child`, `logs`, `streams`, `close()`. The role is stopped the way a
 * deployment stops it, by SIGTERM; a role that has to be killed fails the cleanup.
 */
export async function startRegularRole({
  env,
  port,
  entry = ['dist/main.js'],
  cwd = orchestrator,
  startupTimeoutMs = 60_000,
  shutdownTimeoutMs = 20_000,
}) {
  const child = spawn(process.execPath, entry, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs = []
  // The chunks of each pipe by themselves too (as a worker of the stand keeps them): whoever
  // looks for a value joins the chunks of one pipe.
  const streams = []
  let size = 0,
    exit
  const exited = new Promise((resolve) => {
    child.once('error', () => resolve((exit = { code: null, signal: null, spawned: false })))
    child.once('close', (code, signal) => resolve((exit ??= { code, signal, spawned: true })))
  })
  for (const stream of [child.stdout, child.stderr]) {
    const own = []
    streams.push(own)
    stream.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_LOG_BYTES) return child.kill('SIGKILL')
      const text = chunk.toString()
      logs.push(text)
      own.push(text)
    })
  }
  const within = (ms) => {
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
    })
    return Promise.race([exited, timeout]).finally(() => clearTimeout(timer))
  }
  let closing
  const close = () =>
    (closing ??= (async () => {
      if (exit) return exit
      child.kill('SIGTERM')
      const graceful = await within(shutdownTimeoutMs)
      if (graceful) return graceful
      child.kill('SIGKILL')
      await within(5000)
      throw new Error('The role mcp did not stop on SIGTERM')
    })())
  const deadline = Date.now() + startupTimeoutMs
  for (;;) {
    if (exit || Date.now() > deadline) {
      const early = exit
      await close().catch(() => {})
      // The role prints the names of missing or invalid settings, never their values.
      throw new Error(
        `The role mcp ${early ? 'exited at startup' : 'did not answer /health'}:\n${logs.join('').slice(-4000)}`,
      )
    }
    try {
      const health = await fetch(`http://${LOOPBACK}:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      await health.arrayBuffer()
      if (health.status === 200) break
    } catch {
      /* Not listening yet. */
    }
    await sleep(200)
  }
  return { child, logs, streams, exited, close }
}

/**
 * The address containers reach the host on through `host.docker.internal:host-gateway` on a
 * native Linux engine: the gateway of the default bridge. Docker Desktop forwards that name to
 * the host's loopback instead.
 */
export function bridgeGatewayAddress(inspected) {
  const address = String(inspected).trim()
  const octets = address.split('.').map(Number)
  assert(
    isIP(address) === 4 &&
      (octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168)),
    'The Docker bridge gateway must be a private IPv4 address',
  )
  return address
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']

/**
 * One HTTP hop the stand owns. `observe` sees the method, the path, the headers and the buffered
 * request body before the request is forwarded; throwing there answers 502 and forwards nothing.
 * What it returns is called with the status of the upstream's answer.
 */
export async function startObservingProxy({
  listenHost = LOOPBACK,
  port = 0,
  upstream,
  keepHost,
  observe,
}) {
  const target = new URL(upstream)
  assert.equal(target.protocol, 'http:', 'The observing proxy forwards to local http only')
  const server = createServer((req, res) => {
    const chunks = []
    let size = 0,
      refused = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        if (!refused) res.writeHead(413).end()
        refused = true
      } else chunks.push(chunk)
    })
    req.on('error', () => {})
    req.on('end', async () => {
      if (refused) return
      const body = Buffer.concat(chunks)
      let answered
      try {
        answered = await observe({ method: req.method, path: req.url, headers: req.headers, body })
      } catch {
        res.writeHead(502).end()
        return
      }
      const headers = { ...req.headers }
      for (const name of HOP_BY_HOP) delete headers[name]
      headers['content-length'] = String(body.length)
      if (!keepHost) headers.host = target.host
      const forward = httpRequest(
        { host: target.hostname, port: target.port, method: req.method, path: req.url, headers },
        (answer) => {
          const out = { ...answer.headers }
          for (const name of HOP_BY_HOP) delete out[name]
          res.writeHead(answer.statusCode ?? 502, out)
          answer.pipe(res)
          answer.once('end', () => answered?.(answer.statusCode ?? 502))
        },
      )
      let abandoned = false
      forward.once('error', () => {
        // A request its client gave up has no answer to report; a dead upstream has: 502.
        if (abandoned) return
        if (!res.headersSent) res.writeHead(502)
        res.end()
        answered?.(502)
      })
      // A client that went away takes its upstream request with it.
      res.once('close', () => {
        if (res.writableEnded) return
        abandoned = true
        forward.destroy()
      })
      forward.end(body)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, listenHost, resolve)
  })
  return {
    port: server.address().port,
    origin: `http://${listenHost}:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

const name = (value) => (typeof value === 'string' ? value.slice(0, 64) : null)
const SITE_ROUTES = [
  ['reads', 'GET', /^\/raditi\/v1\/content\/\d+$/],
  ['writes', 'POST', /^\/raditi\/v1\/content\/\d+$/],
  ['operations', 'GET', /^\/raditi\/v1\/operations\/[0-9a-f-]{36}$/],
  ['reconciles', 'POST', /^\/raditi\/v1\/operations\/[0-9a-f-]{36}\/reconcile$/],
  ['forgets', 'POST', /^\/raditi\/v1\/operations\/[0-9a-f-]{36}\/forget$/],
]

/**
 * The stand's two observation points and what they have seen so far. `beforeSiteWrite` is the
 * stand's check of the order the journal promises, run at the moment a write leaves for the
 * site; a failed check is kept as a violation and the write is not forwarded.
 * `aroundCancelled` is the stand's look at what a `notifications/cancelled` changes: called when
 * one arrives, before the role sees it, it returns a check that runs once the role has answered.
 * A failed check, or a look that could not be taken, is kept as a violation; the notification
 * is forwarded either way. `settled()` waits for the checks that still run.
 */
export async function startContentObservers({ mcp, site, beforeSiteWrite, aroundCancelled }) {
  const stats = {
    http: [],
    site: { reads: 0, writes: 0, operations: 0, reconciles: 0, forgets: 0 },
    snapshotBeforeWrite: 0,
    cancelledUnchanged: 0,
    violations: [],
  }
  const checks = new Set()
  const noted = (text) => {
    if (stats.violations.length < 20) stats.violations.push(text)
  }
  const violation = (text) => {
    noted(text)
    throw new Error(text)
  }
  const siteProxy = await startObservingProxy({
    upstream: site.upstream,
    observe: async ({ method, path, body }) => {
      const route = new URL(path, 'http://site.invalid').searchParams.get('rest_route') ?? ''
      const [kind] =
        SITE_ROUTES.find(([, verb, shape]) => verb === method && shape.test(route)) ?? []
      if (!kind) violation('A request outside the companion plugin routes was sent to the site')
      stats.site[kind]++
      if (kind === 'writes') {
        try {
          await beforeSiteWrite(JSON.parse(body.toString('utf8')))
        } catch {
          violation('A write left for the site before its snapshot was stored and admitted')
        }
        stats.snapshotBeforeWrite++
      }
    },
  })
  let mcpProxy
  try {
    mcpProxy = await startObservingProxy({
      listenHost: mcp.listenHost,
      port: mcp.port,
      upstream: mcp.upstream,
      // The role checks the Host sandbox-gw rewrote: it must arrive as it was sent.
      keepHost: true,
      observe: async ({ method, headers, body }) => {
        // The MCP version: the one a client asks for in `initialize`, and after that the one it
        // took from the role's answer, which it names in a header of every later request.
        let rpc = null,
          tool = null,
          protocol = name(headers['mcp-protocol-version'])
        try {
          const parsed = JSON.parse(body.toString('utf8'))
          rpc = name(parsed?.method)
          tool = parsed?.method === 'tools/call' ? name(parsed?.params?.name) : null
          if (parsed?.method === 'initialize') protocol = name(parsed?.params?.protocolVersion)
        } catch {
          /* Not JSON: the role answers that itself. */
        }
        // The stand's own look may fail; the request is the role's to answer all the same.
        let unchanged = null
        if (rpc === 'notifications/cancelled' && aroundCancelled)
          try {
            unchanged = await aroundCancelled()
          } catch {
            noted('A notifications/cancelled could not be looked at')
          }
        return (status) => {
          if (stats.http.length < MAX_ENTRIES)
            stats.http.push({ method, rpc, tool, protocol, status })
          if (!unchanged) return
          const check = Promise.resolve()
            .then(unchanged)
            .then(
              () => {
                stats.cancelledUnchanged++
              },
              () => noted('A notifications/cancelled changed what the platform keeps'),
            )
            .finally(() => checks.delete(check))
          checks.add(check)
        }
      },
    })
  } catch (error) {
    await siteProxy.close()
    throw error
  }
  return {
    siteOrigin: siteProxy.origin,
    stats: () => structuredClone(stats),
    // A check that began while the others were waited for is waited for as well.
    settled: async () => {
      while (checks.size > 0) await Promise.all([...checks])
    },
    close: async () => {
      await mcpProxy.close()
      await siteProxy.close()
    },
  }
}

/** Where the role keeps its home: inside the stand's private directory, never the user's. */
export const roleHome = (directory) => join(directory, 'mcp-role-home')
