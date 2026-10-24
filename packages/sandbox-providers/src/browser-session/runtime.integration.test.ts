import type { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import Docker from 'dockerode'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDockerBrowserSessionRuntime } from './runtime.ts'

// Explicit opt-in (RADITI_BROWSER_DOCKER_TESTS=1), Docker Desktop with runc: a real session —
// the network, the egress proxy, the forwarder and Chromium — driven over the endpoint it
// answers. The images are those of verify:preview-network: the browser and tools images of
// infra/preview/Dockerfile are built when missing, the client egress image (infra/sandbox/
// Dockerfile, `client-egress`) every time, since its proxy is what this suite checks. Only what
// this suite creates is removed.
const enabled = process.env.RADITI_BROWSER_DOCKER_TESTS === '1'
const socketPath = process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock'
const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const docker = new Docker({ socketPath })
const run = promisify(execFile)
// The Docker CLI with only what it needs of this environment.
const dockerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => ['PATH', 'HOME'].includes(name) || name.startsWith('DOCKER_'),
  ),
)

/** The digest of a local tag; null when it was not built. */
const pinned = (tag: string) =>
  docker
    .getImage(tag)
    .inspect()
    .then(
      (info) =>
        info.RepoDigests.find((digest) => digest.startsWith(`${tag.split(':')[0]}@`)) ?? null,
      () => null,
    )

async function build(tag: string, dockerfile: string, target: string, context: string) {
  await run('docker', ['build', '-q', '-f', dockerfile, '--target', target, '-t', tag, context], {
    cwd: repository,
    env: dockerEnv,
    timeout: 900_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const image = await pinned(tag)
  if (!image) throw new Error(`${tag} has no digest after its build`)
  return image
}

/** Playwright of the adapter package (@repo/browser-providers): this one does not depend on it. */
interface Page {
  goto(
    url: string,
    options?: { timeout?: number },
  ): Promise<{
    status(): number
    headers(): Record<string, string>
    text(): Promise<string>
  } | null>
}
interface Browser {
  newContext(): Promise<{
    newPage(): Promise<Page>
    /** The context's request API: the worker's trusted read of the site goes this way. */
    request: {
      get(
        url: string,
        options?: { timeout?: number; maxRedirects?: number },
      ): Promise<{ status(): number; text(): Promise<string> }>
    }
    close(): Promise<void>
  }>
  close(): Promise<void>
}
const playwright = createRequire(
  new URL('../../../browser-providers/package.json', import.meta.url),
)('playwright-core') as {
  chromium: { connect(endpoint: string, options?: object): Promise<Browser> }
}

/** A server on the host: what it was asked, by whom it thinks. */
async function hostServer(reply: string) {
  const seen: { url: string | undefined; headers: IncomingHttpHeaders }[] = []
  const server = createServer((request, response) => {
    seen.push({ url: request.url, headers: request.headers })
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(reply)
  })
  // Docker Desktop carries host-gateway to the host loopback; on Linux it is the bridge's
  // address, reachable from any address of the host.
  const host = process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1'
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  return { server, seen, port: (server.address() as { port: number }).port }
}

const listens = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 2000 })
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => (socket.destroy(), resolve(false)))
  })

/** The JSON lines the egress proxy of a session logged (Docker's non-TTY framing). */
async function egressLog(sessionId: string) {
  const [row] = await docker.listContainers({
    filters: {
      label: [`io.raditi.browser.session=${sessionId}`, 'io.raditi.browser.role=egress'],
    },
  })
  const raw = (await docker
    .getContainer(row!.Id)
    .logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer
  const lines: string[] = []
  for (let at = 0; at + 8 <= raw.length;) {
    const size = raw.readUInt32BE(at + 4)
    lines.push(
      ...raw
        .subarray(at + 8, at + 8 + size)
        .toString('utf8')
        .split('\n'),
    )
    at += 8 + size
  }
  const text = lines.filter(Boolean)
  return {
    text: text.join('\n'),
    entries: text.flatMap((line) => {
      try {
        return [JSON.parse(line) as { event: string; host?: string | null; result: string }]
      } catch {
        return []
      }
    }),
  }
}

/** The exit code of a command in a container of the session, found by its labels. */
async function codeIn(sessionId: string, role: string, argv: string[]) {
  const [row] = await docker.listContainers({
    filters: {
      label: [`io.raditi.browser.session=${sessionId}`, `io.raditi.browser.role=${role}`],
    },
  })
  const exec = await docker.getContainer(row!.Id).exec({ Cmd: argv, AttachStdout: true })
  const stream = await exec.start({})
  stream.resume()
  await new Promise((resolve) => stream.on('end', resolve))
  return (await exec.inspect()).ExitCode
}

describe.skipIf(!enabled)('real Docker browser session runtime', () => {
  const images = { browser: '', forwarder: '', egress: '' }
  const servers: Server[] = []
  const sessions: string[] = []
  let runtime: ReturnType<typeof createDockerBrowserSessionRuntime>

  beforeAll(async () => {
    images.browser =
      (await pinned('raditi-preview-browser:local')) ??
      (await build(
        'raditi-preview-browser:local',
        'infra/preview/Dockerfile',
        'browser',
        'infra/preview',
      ))
    images.forwarder =
      (await pinned('raditi-preview-tools:local')) ??
      (await build(
        'raditi-preview-tools:local',
        'infra/preview/Dockerfile',
        'tools',
        'infra/preview',
      ))
    images.egress = await build(
      'raditi-client-egress:local',
      'infra/sandbox/Dockerfile',
      'client-egress',
      '.',
    )
    runtime = createDockerBrowserSessionRuntime({
      appEnv: 'test',
      runtime: 'runc',
      socketPath,
      images,
      localSites: true,
    })
  }, 1_800_000)

  afterAll(async () => {
    for (const sessionId of sessions) await runtime?.stop(sessionId)
    for (const server of servers) server.close()
  }, 120_000)

  it('loads a local site through the egress proxy and nothing else; leaves nothing after', async () => {
    const site = await hostServer('local site of the stand')
    const other = await hostServer('another service of the host')
    servers.push(site.server, other.server)
    const origin = `http://wp-${randomBytes(3).toString('hex')}.localhost:${site.port}`
    const sessionId = randomUUID()
    sessions.push(sessionId)
    const spec = {
      sessionId,
      taskId: randomUUID(),
      siteId: randomUUID(),
      allowedHosts: ['example.com:443'],
      localSites: [{ origin, target: `host.docker.internal:${site.port}` }],
      deadline: Date.now() + 30 * 60_000,
    }
    const { endpoint } = await runtime.start(spec)
    const url = new URL(endpoint)
    expect(url.hostname).toBe('127.0.0.1')
    expect(await runtime.list()).toContain(sessionId)
    // The secret path is the key: the port alone opens nothing.
    await expect(
      playwright.chromium.connect(`ws://127.0.0.1:${url.port}/${'x'.repeat(43)}`, {
        timeout: 10_000,
      }),
    ).rejects.toThrow()

    const browser = await playwright.chromium.connect(endpoint, { timeout: 60_000 })
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      const loaded = await page.goto(`${origin}/wp-admin/?from=test`, { timeout: 30_000 })
      expect(loaded?.status()).toBe(200)
      expect(await loaded?.text()).toBe('local site of the stand')
      expect(site.seen).toEqual([
        expect.objectContaining({
          url: '/wp-admin/?from=test',
          headers: expect.objectContaining({ host: new URL(origin).host }),
        }),
      ])
      // The request API of the context (the trusted read of the site) takes the same way out:
      // Playwright tunnels it with CONNECT, which the proxy routes to the same local site.
      const read = await context.request.get(`${origin}/wp-json/wp/v2/posts/7?context=edit`, {
        timeout: 30_000,
        maxRedirects: 0,
      })
      expect(read.status()).toBe(200)
      expect(await read.text()).toBe('local site of the stand')
      expect(site.seen.at(-1)).toEqual(
        expect.objectContaining({
          url: '/wp-json/wp/v2/posts/7?context=edit',
          headers: expect.objectContaining({ host: new URL(origin).host }),
        }),
      )

      /** A page that did not open, or the proxy's own refusal of it. */
      const refused = async (address: string) => {
        const answer = await page.goto(address, { timeout: 20_000 }).catch(() => null)
        return answer === null || answer.headers()['raditi-egress'] !== undefined
      }
      // An https host the session does not list: its tunnel is refused.
      expect(await refused('https://example.org/')).toBe(true)
      // Another port of the host: plain HTTP of no route…
      expect(await refused(`http://host.docker.internal:${other.port}/`)).toBe(true)
      // …which the default bridge, where the proxy lives, does reach: only the proxy refuses it.
      expect(
        await codeIn(sessionId, 'egress', [
          '/usr/local/bin/node',
          '-e',
          'require("net").connect(+process.argv[2],process.argv[1]).on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))',
          'host.docker.internal',
          String(other.port),
        ]),
      ).toBe(0)
      expect(other.seen).toEqual([])
      // The metadata service, plain and in a tunnel.
      expect(await refused('http://169.254.169.254/latest/meta-data/')).toBe(true)
      expect(await refused('https://169.254.169.254/')).toBe(true)
      // The local site still opens: the refusals closed nothing of it.
      expect((await page.goto(`${origin}/`, { timeout: 30_000 }))?.status()).toBe(200)
      // The proxy refused each of them itself, for its own reason, and logged no path.
      const log = await egressLog(sessionId)
      const count = (event: string, result: string, host?: string) =>
        log.entries.filter(
          (entry) =>
            entry.event === event &&
            entry.result === result &&
            (host === undefined || entry.host === host),
        ).length
      expect(count('request', 'ok', new URL(origin).host)).toBeGreaterThanOrEqual(2)
      expect(count('connect', 'ok', new URL(origin).host)).toBeGreaterThanOrEqual(1)
      expect(count('connect', 'forbidden_host')).toBeGreaterThanOrEqual(2)
      expect(count('request', 'method')).toBeGreaterThanOrEqual(2)
      expect(log.text).not.toMatch(/wp-admin|wp-json|meta-data|example\.org|from=test/)

      // A second start of a healthy session is the same session.
      expect(await runtime.start(spec)).toEqual({ endpoint })
      await context.close()
    } finally {
      await browser.close().catch(() => {})
    }

    await runtime.stop(sessionId)
    expect(await runtime.list()).not.toContain(sessionId)
    const label = `io.raditi.browser.session=${sessionId}`
    expect(await docker.listContainers({ all: true, filters: { label: [label] } })).toEqual([])
    expect(await docker.listNetworks({ filters: { label: [label] } })).toEqual([])
    expect(await listens(Number(url.port))).toBe(false)
  }, 600_000)
})
