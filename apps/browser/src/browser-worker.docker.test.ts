import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import type { NestExpressApplication } from '@nestjs/platform-express'
import { createBrowserWorkerClient } from '@repo/browser-link'
import {
  decodeBrowserFrame,
  parseBrowserServerMessage,
  type BrowserClientMessage,
  type BrowserServerMessage,
} from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import { startTestBrowser } from './testing/app.ts'
import { fakeInfra, FakeInbox, FakeStore, TEST_WORKER_TOKEN, testEnv } from './testing/fakes.ts'
import { loadBrowserConfig } from './config/config.ts'

// Explicit opt-in (RADITI_BROWSER_DOCKER_TESTS=1), Docker Desktop with runc: the worker app with
// the real runtime of the sessions' containers and the real Playwright browser, against a tiny
// site of this machine named by BROWSER_LOCAL_SITES. The database and the inbox are fakes. The
// images are those of verify:preview-network, built when missing.
const enabled = process.env.RADITI_BROWSER_DOCKER_TESTS === '1'
const socketPath = process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock'
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const run = promisify(execFile)
const dockerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => ['PATH', 'HOME'].includes(name) || name.startsWith('DOCKER_'),
  ),
)

/** The digest of a local tag, built from the repository when missing. */
async function image(tag: string, dockerfile: string, target: string, context: string) {
  const digest = async () => {
    const { stdout } = await run(
      'docker',
      ['image', 'inspect', tag, '--format', '{{json .RepoDigests}}'],
      {
        env: dockerEnv,
      },
    ).catch(() => ({ stdout: '[]' }))
    const [repo] = tag.split(':')
    return (JSON.parse(stdout) as string[]).find((item) => item.startsWith(`${repo}@`)) ?? null
  }
  const known = await digest()
  if (known) return known
  await run('docker', ['build', '-q', '-f', dockerfile, '--target', target, '-t', tag, context], {
    cwd: repository,
    env: dockerEnv,
    timeout: 900_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const built = await digest()
  if (!built) throw new Error(`${tag} has no digest after its build`)
  return built
}

/** Labelled containers of a session, by Docker itself. */
async function containersOf(sessionId: string): Promise<string[]> {
  const { stdout } = await run(
    'docker',
    ['ps', '-aq', '--filter', `label=io.raditi.browser.session=${sessionId}`],
    { env: dockerEnv },
  )
  return stdout.split('\n').filter(Boolean)
}

/** The site: a list of posts with one large link, and what it was asked. */
function site() {
  const seen: string[] = []
  const server = createServer((request, response) => {
    seen.push(request.url ?? '')
    const clicked = (request.url ?? '').includes('clicked=1')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>${clicked ? 'Нажато' : 'Записи'}</title>
<style>html,body{margin:0;padding:0}a{display:block;position:absolute;left:100px;top:100px;width:400px;height:200px;background:#c33;color:#fff;font:32px sans-serif}</style>
</head><body><a href="/wp-admin/edit.php?clicked=1">Открыть</a></body></html>`)
  })
  return { server, seen }
}

describe.skipIf(!enabled)('the browser worker with Docker and Chromium', () => {
  let app: NestExpressApplication | undefined
  let host: Server | undefined
  let base = ''
  let origin = ''
  const store = new FakeStore()
  const local = site()

  beforeAll(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const images = {
      BROWSER_IMAGE: await image(
        'raditi-preview-browser:local',
        'infra/preview/Dockerfile',
        'browser',
        'infra/preview',
      ),
      BROWSER_FORWARDER_IMAGE: await image(
        'raditi-preview-tools:local',
        'infra/preview/Dockerfile',
        'tools',
        'infra/preview',
      ),
      BROWSER_EGRESS_IMAGE: await image(
        'raditi-client-egress:local',
        'infra/sandbox/Dockerfile',
        'client-egress',
        '.',
      ),
    }
    host = local.server
    // Docker Desktop carries host-gateway to the host loopback; on Linux it is the bridge's
    // address, reachable from any address of the host.
    const bind = process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1'
    await new Promise<void>((resolve) => local.server.listen(0, bind, resolve))
    const port = (local.server.address() as AddressInfo).port
    origin = `http://wp-${randomBytes(3).toString('hex')}.localhost:${port}`
    const config = loadBrowserConfig({
      ...testEnv,
      ...images,
      BROWSER_RUNTIME: 'runc',
      BROWSER_DOCKER_SOCKET: socketPath,
      BROWSER_LOCAL_SITES: JSON.stringify({ [origin]: `host.docker.internal:${port}` }),
    })
    app = await startTestBrowser(
      { ...config, port: 0 },
      { prisma: fakeInfra().prisma as never, store, inbox: new FakeInbox() },
    )
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`
  }, 1_800_000)

  afterAll(async () => {
    await app?.close()
    host?.close()
    vi.restoreAllMocks()
  }, 120_000)

  it('streams the site, takes the client’s click, answers the agent and closes clean', async () => {
    const client = createBrowserWorkerClient({ baseUrl: base, token: TEST_WORKER_TOKEN })
    const row = store.open({ siteUrl: origin })
    const state = await client.ensure({
      sessionId: row.id,
      taskId: row.taskId,
      siteId: row.siteId,
      takeControl: true,
    })
    // The stack's start page (Б31), loaded through the session's egress proxy.
    expect(state).toMatchObject({ status: 'ready', controller: 'agent', pageId: 1 })
    expect(state.url).toBe(`${origin}/wp-admin/edit.php`)
    expect(local.seen).toContain('/wp-admin/edit.php')
    expect(await containersOf(row.id)).toHaveLength(3)

    const user = randomUUID()
    store.members.add(`${row.id}:${user}`)
    const ws = new WebSocket(
      `${base.replace('http', 'ws')}/v1/sessions/${row.id}/stream?viewer=${randomUUID()}&user=${user}`,
      { headers: { authorization: `Bearer ${TEST_WORKER_TOKEN}` } },
    )
    const messages: BrowserServerMessage[] = []
    const frames: { frameSeq: number; width: number; height: number; jpeg: number }[] = []
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = decodeBrowserFrame(new Uint8Array(data as Buffer))
        if (!frame) throw new Error('not a frame')
        frames.push({ ...frame.header, jpeg: frame.jpeg.byteLength })
        ws.send(JSON.stringify({ t: 'ack', frameSeq: frame.header.frameSeq }))
        return
      }
      const message = parseBrowserServerMessage(String(data))
      if (message) messages.push(message)
    })
    const until = async (check: () => boolean, ms = 30_000) => {
      const start = Date.now()
      while (!check()) {
        if (Date.now() - start > ms) throw new Error('timed out waiting')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    const send = (message: BrowserClientMessage) => ws.send(JSON.stringify(message))
    await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject))
    await until(() => frames.length > 0)
    expect(messages[0]).toMatchObject({ t: 'state', session: row.id })
    expect(frames[0]).toMatchObject({ width: 1280, height: 800 })
    expect(frames[0]?.jpeg).toBeGreaterThan(100)

    // «Взять управление», then a click of the client on the link at (300, 200).
    send({ t: 'take' })
    await until(() =>
      messages.some((m) => m.t === 'state' && m.controller === 'user' && m.manualReady),
    )
    const click = (type: 'down' | 'up'): BrowserClientMessage => ({
      t: 'input',
      pageId: 1,
      controlEpoch: 1,
      viewportVersion: 1,
      event: { kind: 'mouse', type, x: 300, y: 200, button: 'left', clickCount: 1 },
    })
    send({
      t: 'input',
      pageId: 1,
      controlEpoch: 1,
      viewportVersion: 1,
      event: { kind: 'mouse', type: 'move', x: 300, y: 200, button: 'none', clickCount: 0 },
    })
    send(click('down'))
    send(click('up'))
    await until(() => local.seen.includes('/wp-admin/edit.php?clicked=1'))
    await until(() =>
      messages.some((m) => m.t === 'state' && m.url.endsWith('/wp-admin/edit.php?clicked=1')),
    )
    // While the client controls, the agent is refused; back to the agent, it reads the page.
    const observe = () =>
      client.action(row.id, {
        taskId: row.taskId,
        assignmentId: randomUUID(),
        action: { tool: 'web_observe' },
      })
    await expect(observe()).rejects.toMatchObject({ code: 'BROWSER_USER_IN_CONTROL' })
    send({ t: 'release' })
    await until(() =>
      messages.some((m) => m.t === 'state' && m.controller === 'agent' && m.controlEpoch === 2),
    )
    const observed = await observe()
    expect(observed).toMatchObject({
      tool: 'web_observe',
      observation: 'o1',
      page: { title: 'Нажато' },
    })
    expect(observed.tool === 'web_observe' && observed.tree).toContain('link "Открыть"')
    expect(store.wrote).toBe(1)

    const closed = new Promise<number>((resolve) => ws.once('close', resolve))
    expect(await client.close(row.id, { reason: 'task_done' })).toEqual({
      sessionId: row.id,
      status: 'closed',
    })
    expect(await closed).toBe(1000)
    expect(messages.at(-1)).toEqual({ t: 'closed', reason: 'task_done' })
    expect(await containersOf(row.id)).toEqual([])
    expect(await client.list()).toEqual({ sessions: [] })
  }, 300_000)
})
