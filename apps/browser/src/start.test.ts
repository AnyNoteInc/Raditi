import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import type { NestExpressApplication } from '@nestjs/platform-express'
import { createBrowserWorkerClient } from '@repo/browser-link'
import { isDomainError, parseBrowserServerMessage } from '@repo/domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import { startBrowser } from './start.ts'
import { startTestBrowser } from './testing/app.ts'
import {
  fakeInfra,
  FakeBrowsers,
  FakeInbox,
  FakeRuntime,
  FakeStore,
  TEST_METRICS_TOKEN,
  TEST_WORKER_TOKEN,
  testBrowserConfig,
} from './testing/fakes.ts'

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    if (isDomainError(error)) return error.code
    throw error
  }
  throw new Error('expected a refusal')
}

describe('the browser worker app', () => {
  let app: NestExpressApplication | undefined
  let base = ''
  let store: FakeStore
  let runtime: FakeRuntime
  let browsers: FakeBrowsers

  beforeEach(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    store = new FakeStore()
    runtime = new FakeRuntime()
    browsers = new FakeBrowsers()
    app = await startTestBrowser(
      { ...testBrowserConfig({ METRICS_TOKEN: TEST_METRICS_TOKEN }), port: 0 },
      {
        prisma: fakeInfra().prisma as never,
        store,
        runtime,
        browsers,
        inbox: new FakeInbox(),
      },
    )
    const address = app.getHttpServer().address() as AddressInfo
    expect(address.address).toBe('127.0.0.1')
    base = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.restoreAllMocks()
  })

  const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const { token = TEST_WORKER_TOKEN, ...rest } = init
    return fetch(`${base}${path}`, {
      ...rest,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(rest.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(rest.headers as Record<string, string> | undefined),
      },
    })
  }

  it('answers 401 without the token, and says nothing else', async () => {
    for (const token of [null, 'wrong-token-of-another-service-0123456789']) {
      const listed = await call('/v1/sessions', { token })
      expect(listed.status).toBe(401)
      expect(await listed.json()).toEqual({ code: 'UNAUTHORIZED' })
      const ensured = await call('/v1/sessions/ensure', { method: 'POST', body: '{}', token })
      expect(ensured.status).toBe(401)
    }
    // A path outside the API is no route; within it, a refusal is a code only.
    const missing = await call('/v1/nothing-here')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ code: 'NOT_FOUND' })
  })

  it('refuses a body that is not the contract’s with a code and no detail', async () => {
    const bad = await call('/v1/sessions/ensure', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'x', siteUrl: 'https://secret.example.ru/?token=abc' }),
    })
    expect(bad.status).toBe(400)
    expect(await bad.text()).toBe('{"code":"BAD_REQUEST"}')
    // A valid ensure that also names where the browser should go: the worker reads the site's
    // address from the database alone, so the field is refused, not ignored.
    const row = store.open()
    for (const extra of [
      { siteUrl: 'https://evil.example.com' },
      { agentNotes: 'Вход по адресу /login' },
    ]) {
      const named = await call('/v1/sessions/ensure', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: row.id,
          taskId: row.taskId,
          siteId: row.siteId,
          takeControl: true,
          ...extra,
        }),
      })
      expect(named.status).toBe(400)
      expect(await named.json()).toEqual({ code: 'BAD_REQUEST' })
    }
    expect(runtime.started).toEqual([])
    const text = await call('/v1/sessions/ensure', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'text/plain' },
    })
    expect(text.status).toBe(415)
    const large = await call('/v1/sessions/ensure', {
      method: 'POST',
      body: JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
    })
    expect(large.status).toBe(413)
    expect(await large.json()).toEqual({ code: 'PAYLOAD_TOO_LARGE' })
    const id = await call('/v1/sessions/not-a-uuid/close', {
      method: 'POST',
      body: JSON.stringify({ reason: 'task_done' }),
    })
    expect(id.status).toBe(400)
  })

  it('speaks the contract of the client core and mcp use, refusals included', async () => {
    const client = createBrowserWorkerClient({ baseUrl: base, token: TEST_WORKER_TOKEN })
    const row = store.open()
    const state = await client.ensure({
      sessionId: row.id,
      taskId: row.taskId,
      siteId: row.siteId,
      takeControl: true,
    })
    expect(state).toMatchObject({ session: row.id, status: 'ready', controller: 'agent' })
    expect(await client.list()).toEqual({
      sessions: [{ sessionId: row.id, taskId: row.taskId, status: 'ready' }],
    })
    const action = (taskId = row.taskId) =>
      client.action(row.id, {
        taskId,
        assignmentId: randomUUID(),
        action: { tool: 'web_observe' },
      })
    expect(await action()).toMatchObject({ tool: 'web_observe', observation: 'o1' })
    // A refusal of the worker reaches the agent as its fixed code.
    expect(await codeOf(action(randomUUID()))).toBe('BROWSER_SESSION_UNAVAILABLE')
    const raw = await call(`/v1/sessions/${row.id}/actions`, {
      method: 'POST',
      body: JSON.stringify({
        taskId: row.taskId,
        assignmentId: randomUUID(),
        action: { tool: 'web_click', observation: 'o7', ref: 'e1' },
      }),
    })
    expect(raw.status).toBe(409)
    expect(await raw.json()).toEqual({ code: 'BROWSER_STALE_OBSERVATION' })
    expect(await client.verify(row.id)).toEqual({ checkpoints: [] })
    expect(await client.close(row.id, { reason: 'task_done' })).toEqual({
      sessionId: row.id,
      status: 'closed',
    })
    expect(runtime.stopped).toEqual([row.id])
    expect(browsers.last.closed).toBe(true)
    expect(await codeOf(client.close(randomUUID(), { reason: 'task_done' }))).toBe('NOT_FOUND')
  })

  it('serves the stream on the same port, behind the same token', async () => {
    const row = store.open()
    const client = createBrowserWorkerClient({ baseUrl: base, token: TEST_WORKER_TOKEN })
    await client.ensure({
      sessionId: row.id,
      taskId: row.taskId,
      siteId: row.siteId,
      takeControl: true,
    })
    const user = randomUUID()
    store.members.add(`${row.id}:${user}`)
    const ws = new WebSocket(
      `${base.replace('http', 'ws')}/v1/sessions/${row.id}/stream?viewer=${randomUUID()}&user=${user}`,
      { headers: { authorization: `Bearer ${TEST_WORKER_TOKEN}` } },
    )
    const first = await new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(String(data)))
      ws.once('error', reject)
    })
    expect(parseBrowserServerMessage(first)).toMatchObject({ t: 'state', session: row.id })
    ws.terminate()
  })

  it('answers its health and its metrics with the metrics token only', async () => {
    const health = await call('/health', { token: null })
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    const detailed = await call('/health', { token: TEST_METRICS_TOKEN })
    expect(await detailed.json()).toEqual({
      status: 'ok',
      checks: { database: 'ok', docker: 'ok' },
    })
    expect((await call('/metrics', { token: null })).status).toBe(401)
    // The worker's token opens its API, not its metrics.
    expect((await call('/metrics')).status).toBe(401)
    const metrics = await call('/metrics', { token: TEST_METRICS_TOKEN })
    const text = await metrics.text()
    expect(text).toContain('raditi_browser_sessions{app="browser"} 0')
    expect(text).toContain('raditi_browser_frames_sent_total')
    expect(text).toContain('raditi_browser_actions_total')
  })
})

describe('startBrowser', () => {
  let app: NestExpressApplication | undefined

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.restoreAllMocks()
  })

  it('composes the app on its own providers and opens its port on 127.0.0.1 outside production', async () => {
    // No containers: nothing reaches Docker; the database is never asked before a request.
    app = await startBrowser({ ...testBrowserConfig(), runtime: null, port: 0 })
    const address = app.getHttpServer().address() as AddressInfo
    expect(address.address).toBe('127.0.0.1')
    const base = `http://127.0.0.1:${address.port}`
    const listed = await fetch(`${base}/v1/sessions`)
    expect(listed.status).toBe(401)
    expect(await listed.json()).toEqual({ code: 'UNAUTHORIZED' })
    expect((await fetch(`${base}/metrics`)).status).toBe(401)
  })
})
