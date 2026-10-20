import { randomUUID } from 'node:crypto'

import {
  conflict,
  PageBrowserError,
  type KvSecret,
  type PageBrowser,
  type PageBrowserConnection,
  type PreviewStatus,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { newTurnKeys } from '@repo/turn-keys'
import { memoryStorage } from '@repo/snapshots/testing'
import { contentMaskPath, ContentPrivacy } from './content-privacy.ts'
import type { McpAccess } from './mcp-access.ts'
import { browserScreenshotKey, McpBrowserService, type McpBrowserOptions } from './mcp-browser.ts'
import type { McpBrowserAdmission, McpBrowserStore } from './mcp-browser-store.ts'

const HOST = 'site-0a1b2c3d-chat-0a1b2c.localhost'
const ORIGIN = `http://${HOST}:8090`
const address = { baseDomain: 'localhost', scheme: 'http' as const, publicPort: 8090 }
const TICKET = 'T'.repeat(43)
const WS_PATH = `/${'s'.repeat(43)}`

function scopeOf(status: PreviewStatus = 'ready'): McpAccess {
  return {
    keyId: randomUUID(),
    taskId: randomUUID(),
    workspaceId: randomUUID(),
    siteId: randomUUID(),
    sessionId: 'synthetic',
    turn: 2,
    firstEpoch: 1,
    epoch: 1,
    stack: 'wordpress',
    url: 'https://site.example.test/',
    preview: { id: randomUUID(), status, database: true, hostname: HOST },
  }
}

/** A page browser that answers what a test tells it; every action is a spy. */
function fakePage() {
  const location = { path: '/', title: 'Главная', status: 200 }
  let connected = true
  const page = {
    navigate: vi.fn<PageBrowser['navigate']>(async (input) => ({ ...location, path: input.path })),
    click: vi.fn<PageBrowser['click']>(async () => ({ ...location, status: null })),
    fill: vi.fn<PageBrowser['fill']>(async () => ({ ...location, status: null })),
    expect: vi.fn<PageBrowser['expect']>(async () => ({ passed: true })),
    snapshot: vi.fn<PageBrowser['snapshot']>(async () => ({
      ...location,
      text: '- heading "Добро пожаловать"',
      links: [{ text: 'О нас', path: '/about/' }],
    })),
    screenshot: vi.fn<PageBrowser['screenshot']>(async () => ({
      bytes: Buffer.from('89504e470d0a1a0a', 'hex'),
      contentType: 'image/png' as const,
      width: 1280,
      height: 800,
    })),
    console: vi.fn<PageBrowser['console']>(async () => []),
    network: vi.fn<PageBrowser['network']>(async () => []),
    isConnected: vi.fn(() => connected),
    close: vi.fn(async () => {
      connected = false
    }),
    drop: () => {
      connected = false
    },
  }
  return page
}

function fixture(
  options: {
    status?: PreviewStatus
    store?: Partial<McpBrowserStore>
    service?: McpBrowserOptions
    /** How every page this fixture opens answers. */
    page?: (page: ReturnType<typeof fakePage>) => void
  } = {},
) {
  const scope = scopeOf(options.status)
  const assignmentId = randomUUID()
  const clock = { now: 1_000_000 }
  const admission = (): McpBrowserAdmission => ({
    assignmentId,
    turnId: randomUUID(),
    turnNo: scope.turn,
    now: new Date(clock.now),
    deadlineAt: new Date(clock.now + 600_000),
    preview: {
      id: scope.preview!.id,
      status: options.status ?? 'ready',
      hostname: HOST,
      database: true,
      revision: 1,
    },
  })
  const requests: string[] = []
  const base = {
    admit: vi.fn<McpBrowserStore['admit']>(async () => admission()),
    requestSync: vi.fn<McpBrowserStore['requestSync']>(async () => randomUUID()),
    syncState: vi.fn<McpBrowserStore['syncState']>(async (id) => ({
      id,
      done: true,
      errorCode: null,
    })),
    requestBrowser: vi.fn<McpBrowserStore['requestBrowser']>(async () => {
      const id = randomUUID()
      requests.push(id)
      return id
    }),
    browserState: vi.fn<McpBrowserStore['browserState']>(async (id) => ({
      id,
      done: true,
      errorCode: null,
    })),
    markDirty: vi.fn<McpBrowserStore['markDirty']>(async () => undefined),
    recordChecks: vi.fn<McpBrowserStore['recordChecks']>(async () => undefined),
    recordScreenshot: vi.fn<McpBrowserStore['recordScreenshot']>(async () => undefined),
    liveAssignments: vi.fn<McpBrowserStore['liveAssignments']>(async (ids) => new Set(ids)),
  } satisfies McpBrowserStore
  // A test replaces a method with a spy of its own.
  const store = { ...base, ...options.store } as typeof base
  // Vault: the contact map of the task (CAS) and the browser secret core wrote for the latest
  // request of the turn.
  const records = new Map<string, KvSecret>()
  const secrets = {
    kvRead: vi.fn(async (path: string): Promise<KvSecret | null> => {
      if (path === `kv/previews/${scope.preview!.id}/browser`)
        return {
          version: 1,
          data: {
            v: '1',
            requestId: requests.at(-1) ?? randomUUID(),
            wsEndpoint: 'ws://127.0.0.1:9222',
            wsPath: WS_PATH,
            enterUrl: `${ORIGIN}/__raditi/enter?t=${TICKET}&to=%2F`,
          },
        }
      return records.get(path) ?? null
    }),
    kvWrite: vi.fn(async (path: string, data: Record<string, string>, opts?: { cas?: number }) => {
      const version = records.get(path)?.version ?? 0
      if (opts?.cas !== version) throw conflict('Synthetic CAS mismatch')
      records.set(path, { data: { ...data }, version: version + 1 })
      return { version: version + 1 }
    }),
  }
  const pages: ReturnType<typeof fakePage>[] = []
  const connections: PageBrowserConnection[] = []
  const factory = {
    connect: vi.fn(async (connection: PageBrowserConnection) => {
      connections.push(connection)
      const page = fakePage()
      options.page?.(page)
      pages.push(page)
      return page
    }),
  }
  const memory = memoryStorage()
  const adapter = {
    browserRequestDenied: vi.fn((request: { path: string }) =>
      request.path.startsWith('/wp-admin/'),
    ),
  }
  const service = new McpBrowserService(
    {
      store,
      factory,
      secrets,
      privacy: new ContentPrivacy(secrets),
      storage: memory.storage,
      adapters: () => adapter,
      address,
    },
    {
      sweepMs: 0,
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms
      },
      ...options.service,
    },
  )
  return {
    scope,
    assignmentId,
    admission,
    clock,
    store,
    secrets,
    records,
    factory,
    pages,
    connections,
    memory,
    adapter,
    service,
    page: () => pages.at(-1)!,
  }
}

const refused = (code: string) => expect.objectContaining({ code })

describe('the browser of the agent on its preview', () => {
  it('syncs the working tree, opens the browser core started and enters with its ticket', async () => {
    const { scope, service, store, factory, connections, adapter, page } = fixture()
    expect(await service.navigate(scope, { path: '/about/' })).toEqual({
      path: '/about/',
      title: 'Главная',
      status: 200,
    })
    expect(store.requestSync).toHaveBeenCalledOnce()
    // Admitted again after the sync: the preview may have moved while core worked.
    expect(store.admit).toHaveBeenCalledTimes(2)
    expect(store.requestBrowser).toHaveBeenCalledExactlyOnceWith(expect.anything(), false)
    expect(factory.connect).toHaveBeenCalledOnce()
    expect(connections[0]).toMatchObject({
      endpoint: { wsEndpoint: `ws://127.0.0.1:9222${WS_PATH}` },
      origin: ORIGIN,
      enterUrl: `${ORIGIN}/__raditi/enter?t=${TICKET}&to=%2F`,
    })
    // Every request of a page is the stack's question, asked of the site adapter.
    expect(connections[0]!.denyRequest({ path: '/wp-admin/', method: 'GET', postData: null })).toBe(
      true,
    )
    expect(adapter.browserRequestDenied).toHaveBeenCalled()
    expect(page().navigate).toHaveBeenCalledExactlyOnceWith({ path: '/about/' })
  })

  it('keeps one context per turn and opens a new one for the next turn', async () => {
    const { scope, service, factory, store, admission, pages } = fixture()
    await service.navigate(scope, { path: '/' })
    await service.snapshot(scope)
    expect(factory.connect).toHaveBeenCalledOnce()
    expect(service.sessions).toBe(1)
    const next = randomUUID()
    store.admit.mockImplementation(async () => ({ ...admission(), assignmentId: next }))
    await service.navigate(scope, { path: '/' })
    expect(factory.connect).toHaveBeenCalledTimes(2)
    expect(service.sessions).toBe(2)
    // The first turn has ended: the sweep closes its context, and only its.
    store.liveAssignments.mockResolvedValueOnce(new Set([next]))
    expect(await service.sweep()).toBe(1)
    expect(service.sessions).toBe(1)
    expect(pages[0]!.close).toHaveBeenCalledOnce()
    expect(pages[1]!.close).not.toHaveBeenCalled()
  })

  it('refuses a path of another origin, of the gateway or one the stack denies, asking core nothing', async () => {
    const { scope, service, store, factory } = fixture()
    for (const path of [
      'https://elsewhere.example/',
      `http://site-0a1b2c3d-chat-ffffff.localhost:8090/`,
      '//elsewhere.example/',
      '/__raditi/enter?t=x&to=/',
      '/wp-admin/users.php',
      '/a\\b',
    ])
      await expect(service.navigate(scope, { path })).rejects.toEqual(
        refused('BROWSER_PATH_DENIED'),
      )
    expect(store.admit).not.toHaveBeenCalled()
    expect(factory.connect).not.toHaveBeenCalled()
  })

  it('opens an address of the preview by its path, without its fragment', async () => {
    const { scope, service, page } = fixture()
    await service.navigate(scope, { path: `${ORIGIN}/about/?x=1#top` })
    expect(page().navigate).toHaveBeenCalledExactlyOnceWith({ path: '/about/?x=1' })
  })

  it('waits for the sync a bounded time and asks for no browser when core does not answer', async () => {
    const { scope, service, store, factory, clock } = fixture({
      store: { syncState: vi.fn(async (id: string) => ({ id, done: false, errorCode: null })) },
    })
    const started = clock.now
    await expect(service.navigate(scope, { path: '/' })).rejects.toEqual(
      refused('BROWSER_SYNC_TIMEOUT'),
    )
    expect(clock.now - started).toBe(20_000)
    expect(store.requestBrowser).not.toHaveBeenCalled()
    expect(factory.connect).not.toHaveBeenCalled()
  })

  it('stops at a sync core refused', async () => {
    const { scope, service, factory } = fixture({
      store: {
        syncState: vi.fn(async (id: string) => ({ id, done: true, errorCode: 'unsafe_archive' })),
      },
    })
    await expect(service.snapshot(scope)).rejects.toEqual(refused('BROWSER_SYNC_FAILED'))
    expect(factory.connect).not.toHaveBeenCalled()
  })

  it.each([
    ['building', 'BROWSER_PREVIEW_NOT_READY'],
    ['pending', 'BROWSER_PREVIEW_NOT_READY'],
    ['expired', 'BROWSER_PREVIEW_NOT_READY'],
    ['failed', 'BROWSER_PREVIEW_UNAVAILABLE'],
    ['unavailable', 'BROWSER_PREVIEW_UNAVAILABLE'],
    ['destroyed', 'BROWSER_PREVIEW_UNAVAILABLE'],
  ] as const)('answers a preview %s with %s, before any sync', async (status, code) => {
    const { scope, service, store } = fixture({ status })
    await expect(service.navigate(scope, { path: '/' })).rejects.toEqual(refused(code))
    expect(store.requestSync).not.toHaveBeenCalled()
  })

  it('waits for the browser a bounded time', async () => {
    const { scope, service, factory, clock } = fixture({
      store: { browserState: vi.fn(async (id: string) => ({ id, done: false, errorCode: null })) },
    })
    const started = clock.now
    await expect(service.navigate(scope, { path: '/' })).rejects.toEqual(
      refused('BROWSER_NOT_READY'),
    )
    expect(clock.now - started).toBe(25_000)
    expect(factory.connect).not.toHaveBeenCalled()
  })

  it('asks for a new request once when the browser stopped, the ticket is another one or entry failed', async () => {
    const stopped = fixture()
    stopped.store.browserState
      .mockResolvedValueOnce({ id: 'a', done: true, errorCode: 'stopped' })
      .mockResolvedValueOnce({ id: 'b', done: true, errorCode: null })
    await stopped.service.navigate(stopped.scope, { path: '/' })
    expect(stopped.store.requestBrowser.mock.calls.map((call) => call[1])).toEqual([false, true])

    // The open request of the turn kept a ticket that is spent or expired — a wait that gave
    // up before core answered, a restart of this process —: the gateway refuses the entry.
    const spent = fixture()
    spent.factory.connect.mockRejectedValueOnce(new PageBrowserError('denied'))
    await spent.service.navigate(spent.scope, { path: '/' })
    expect(spent.store.requestBrowser.mock.calls.map((call) => call[1])).toEqual([false, true])
    expect(spent.service.sessions).toBe(1)
    const spentAgain = fixture()
    spentAgain.factory.connect.mockRejectedValue(new PageBrowserError('denied'))
    await expect(spentAgain.service.navigate(spentAgain.scope, { path: '/' })).rejects.toEqual(
      refused('BROWSER_UNAVAILABLE'),
    )
    expect(spentAgain.service.sessions).toBe(0)

    const broken = fixture()
    broken.factory.connect.mockRejectedValue(new PageBrowserError('closed'))
    await expect(broken.service.navigate(broken.scope, { path: '/' })).rejects.toEqual(
      refused('BROWSER_UNAVAILABLE'),
    )
    expect(broken.factory.connect).toHaveBeenCalledTimes(2)

    const refusedByCore = fixture()
    refusedByCore.store.browserState.mockResolvedValue({
      id: 'c',
      done: true,
      errorCode: 'no_image',
    })
    await expect(
      refusedByCore.service.navigate(refusedByCore.scope, { path: '/' }),
    ).rejects.toEqual(refused('BROWSER_UNAVAILABLE'))
    expect(refusedByCore.factory.connect).not.toHaveBeenCalled()
  })

  it('takes the secret of its own request only', async () => {
    const { scope, service, secrets, factory, store } = fixture()
    const original = secrets.kvRead.getMockImplementation()!
    secrets.kvRead.mockImplementationOnce(async (path) => ({
      ...(await original(path))!,
      data: { ...(await original(path))!.data, requestId: randomUUID() },
    }))
    await service.navigate(scope, { path: '/' })
    expect(store.requestBrowser.mock.calls.map((call) => call[1])).toEqual([false, true])
    expect(factory.connect).toHaveBeenCalledOnce()
  })

  it('marks the preview dirty before a click or a fill, not before reading it', async () => {
    const { scope, service, store, page } = fixture()
    await service.navigate(scope, { path: '/' })
    await service.expect(scope, { selector: '#out', text: 'Привет' })
    await service.snapshot(scope)
    expect(store.markDirty).not.toHaveBeenCalled()
    store.markDirty.mockImplementationOnce(async () => {
      expect(page().click).not.toHaveBeenCalled()
    })
    await service.click(scope, { role: 'button', name: 'Отправить' })
    await service.fill(scope, { selector: '#name', value: 'Анна' })
    expect(store.markDirty).toHaveBeenCalledTimes(2)
    expect(page().click).toHaveBeenCalledExactlyOnceWith({
      role: 'button',
      name: 'Отправить',
      timeoutMs: 10_000,
    })
    expect(page().fill).toHaveBeenCalledExactlyOnceWith({
      selector: '#name',
      value: 'Анна',
      timeoutMs: 10_000,
    })
  })

  it('refuses a turn credential in a value and types contacts for their markers', async () => {
    const { scope, service, store, page, records } = fixture()
    const keys = newTurnKeys()
    for (const value of [`ключ ${keys.llmApiKey}`, keys.mcpToken])
      await expect(service.fill(scope, { selector: '#name', value })).rejects.toEqual(
        refused('BROWSER_CREDENTIAL_REFUSED'),
      )
    expect(store.admit).not.toHaveBeenCalled()
    // The agent saw the contact as a marker; the page gets the contact.
    const id = randomUUID()
    records.set(contentMaskPath(scope), {
      version: 1,
      data: { entries: JSON.stringify([{ id, kind: 'email', value: 'anna@example.test' }]) },
    })
    await service.fill(scope, {
      selector: '#email',
      value: `[[raditi:email:${id}]]`,
    })
    expect(page().fill).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'anna@example.test' }),
    )
    await expect(
      service.fill(scope, { selector: '#email', value: `[[raditi:email:${randomUUID()}]]` }),
    ).rejects.toEqual(refused('BROWSER_ACTION_FAILED'))
  })

  it('hides contacts of a page from the model and bounds what it reads', async () => {
    const { scope, service, page, records } = fixture({ service: { responseBytes: 4_096 } })
    await service.navigate(scope, { path: '/' })
    page().snapshot.mockResolvedValueOnce({
      path: '/contacts/',
      title: 'Контакты',
      status: 200,
      text: `- text "Пишите: anna@example.test"\n${'- text "строка"\n'.repeat(400)}`,
      links: [{ text: 'anna@example.test', path: '/contacts/?to=anna@example.test' }],
    })
    const snapshot = await service.snapshot(scope)
    expect(JSON.stringify(snapshot)).not.toContain('anna@example.test')
    expect(JSON.stringify(snapshot)).toContain('[[raditi:email:')
    expect(snapshot).toMatchObject({ path: '/contacts/', title: 'Контакты', truncated: true })
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(4_096)
    expect(records.has(contentMaskPath(scope))).toBe(true)
  })

  it('keeps the pixels of a screenshot for the client: the agent gets their id', async () => {
    const { scope, service, memory, store } = fixture()
    store.recordScreenshot.mockImplementationOnce(async () => {
      // Recorded first: the sweep of the task's content finds every object it may have stored.
      expect(memory.storage.put).not.toHaveBeenCalled()
    })
    const answer = await service.screenshot(scope)
    expect(Object.keys(answer).sort()).toEqual(['height', 'screenshotId', 'width'])
    // With the sync it looked at: the candidate's check takes it when it is the same look.
    expect(store.recordScreenshot).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      scope.taskId,
      answer.screenshotId,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    )
    const key = browserScreenshotKey(scope.taskId, answer.screenshotId as string)
    expect(key).toBe(`tasks/${scope.taskId}/screenshots/${answer.screenshotId as string}.png`)
    expect(memory.storage.put).toHaveBeenCalledExactlyOnceWith(
      'artifacts',
      key,
      expect.any(Uint8Array),
      { contentType: 'image/png', sizeBytes: 8 },
    )
    memory.storage.put.mockRejectedValueOnce(new Error('private S3 detail'))
    await expect(service.screenshot(scope)).rejects.toEqual(
      refused('BROWSER_SCREENSHOT_UNAVAILABLE'),
    )
  })

  it('reads the console and the failed requests of an open page only, masked', async () => {
    const { scope, service, page, store } = fixture()
    expect(await service.console(scope)).toEqual({ entries: [] })
    expect(await service.network(scope)).toEqual({ requests: [] })
    // Neither syncs nor starts a browser.
    expect(store.requestSync).not.toHaveBeenCalled()
    expect(store.requestBrowser).not.toHaveBeenCalled()
    await service.navigate(scope, { path: '/' })
    page().console.mockResolvedValueOnce([
      { level: 'error', text: 'Не отправлено на anna@example.test' },
    ])
    page().network.mockResolvedValueOnce([
      { method: 'GET', path: '/ok.css', status: 200, resourceType: 'stylesheet' },
      { method: 'GET', path: '/missing.png', status: 404, resourceType: 'image' },
      { method: 'GET', path: null, status: null, resourceType: 'fetch' },
    ])
    const consoleAnswer = await service.console(scope)
    expect(JSON.stringify(consoleAnswer)).not.toContain('anna@example.test')
    // A contact across the bound of a message is masked whole, then the message is cut: no part
    // of it — nor of its marker — is left.
    page().console.mockResolvedValueOnce([
      { level: 'log', text: `${'слово '.repeat(165)}ivan.petrov@mail.ru и ещё текст` },
    ])
    const cut = (await service.console(scope)) as { entries: Array<{ text: string }> }
    expect(cut.entries[0]!.text.length).toBeLessThanOrEqual(1_000)
    expect(cut.entries[0]!.text).not.toMatch(/ivan|petrov|mail\.ru|\[\[raditi:(?![^\]]*\]\])/)
    expect(await service.network(scope)).toEqual({
      requests: [
        { method: 'GET', path: '/missing.png', status: 404, type: 'image' },
        { method: 'GET', path: null, status: null, type: 'fetch' },
      ],
    })
  })

  it('answers what the browser raised with a fixed code and reopens a lost browser', async () => {
    const { scope, service, page, factory, store } = fixture()
    await service.navigate(scope, { path: '/' })
    page().click.mockRejectedValueOnce(new PageBrowserError('timeout'))
    await expect(service.click(scope, { selector: '#missing' })).rejects.toEqual(
      refused('BROWSER_TIMEOUT'),
    )
    page().navigate.mockRejectedValueOnce(new PageBrowserError('denied'))
    await expect(service.navigate(scope, { path: '/away/' })).rejects.toEqual(
      refused('BROWSER_ACTION_DENIED'),
    )
    page().navigate.mockRejectedValueOnce(new Error('page said: secret'))
    const failed = await service.navigate(scope, { path: '/' }).catch((error: unknown) => error)
    expect(failed).toEqual(refused('BROWSER_ACTION_FAILED'))
    expect(JSON.stringify(failed)).not.toContain('secret')
    page().navigate.mockRejectedValueOnce(new PageBrowserError('closed'))
    await expect(service.navigate(scope, { path: '/' })).rejects.toEqual(
      refused('BROWSER_UNAVAILABLE'),
    )
    expect(service.sessions).toBe(0)
    await service.navigate(scope, { path: '/' })
    expect(factory.connect).toHaveBeenCalledTimes(2)
    // The first ticket was spent by the first entry: the turn asks for a new request at once.
    expect(store.requestBrowser.mock.calls.map((call) => call[1])).toEqual([false, true])
  })

  it('runs declarative checks and records their counts', async () => {
    const { scope, service, store, pages } = fixture({
      page: (page) => {
        page.navigate.mockImplementation(async (input) => ({
          path: input.path,
          title: 'Страница',
          status: input.path === '/gone/' ? 404 : 200,
        }))
        page.expect.mockImplementation(async (input) => ({ passed: input.selector !== '#out' }))
      },
    })
    const result = await service.runChecks(scope, {
      checks: [
        { path: '/' },
        { path: '/about/', selector: 'h1', text: 'О компании' },
        { path: '/wp-admin/' },
        { path: '/gone/' },
        { path: '/form/', selector: '#out', state: 'visible' },
        { path: '/gone/', status: 404 },
      ],
    })
    expect(result).toEqual({
      total: 6,
      passed: 3,
      failed: 3,
      results: [
        { check: 1, passed: true },
        { check: 2, passed: true },
        { check: 3, passed: false, reason: 'denied' },
        { check: 4, passed: false, reason: 'status' },
        { check: 5, passed: false, reason: 'element' },
        { check: 6, passed: true },
      ],
    })
    // One sync for the whole run; the denied path was never opened.
    expect(store.requestSync).toHaveBeenCalledOnce()
    expect(pages[0]!.navigate.mock.calls.map(([input]) => input.path)).toEqual([
      '/',
      '/about/',
      '/gone/',
      '/form/',
      '/gone/',
    ])
    expect(pages[0]!.expect).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'h1', text: 'О компании', timeoutMs: 5_000 }),
    )
    // Bound to the sync the run looked at: the pass of the turn carries it into its candidate.
    const sync = await store.requestSync.mock.results[0]!.value
    expect(store.recordChecks).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      scope.taskId,
      { total: 6, passed: 3, failed: 3 },
      sync,
    )
    // Nothing of a check comes back but its number and a word.
    expect(JSON.stringify(result)).not.toContain('О компании')
  })

  it('reports checks the time of the call no longer allows as not run', async () => {
    const { scope, service, clock } = fixture({
      page: (page) => {
        page.navigate.mockImplementation(async (input) => {
          clock.now += 30_000
          return { path: input.path, title: 'Страница', status: 200 }
        })
      },
    })
    const result = await service.runChecks(scope, {
      checks: [{ path: '/' }, { path: '/a/' }, { path: '/b/' }],
    })
    expect(result).toMatchObject({
      total: 3,
      passed: 2,
      results: [
        { check: 1, passed: true },
        { check: 2, passed: true },
        { check: 3, passed: false, reason: 'not_run' },
      ],
    })
  })

  it('serves one call of a turn at a time', async () => {
    const { scope, service, page } = fixture()
    await service.navigate(scope, { path: '/' })
    const order: string[] = []
    let release!: () => void
    page().click.mockImplementationOnce(async () => {
      order.push('click started')
      await new Promise<void>((resolve) => (release = resolve))
      order.push('click done')
      return { path: '/', title: 'Главная', status: null }
    })
    page().navigate.mockImplementationOnce(async (input) => {
      order.push('navigate')
      return { path: input.path, title: 'Главная', status: 200 }
    })
    const click = service.click(scope, { selector: '#go' })
    await vi.waitFor(() => expect(order).toEqual(['click started']))
    const navigate = service.navigate(scope, { path: '/about/' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['click started'])
    release()
    await Promise.all([click, navigate])
    expect(order).toEqual(['click started', 'click done', 'navigate'])
  })

  it('closes contexts of idle turns and lost browsers, and all of them with the module', async () => {
    const { scope, service, page, clock } = fixture()
    await service.navigate(scope, { path: '/' })
    expect(await service.sweep()).toBe(0)
    clock.now += 15 * 60_000
    expect(await service.sweep()).toBe(1)
    expect(page().close).toHaveBeenCalledOnce()
    await service.navigate(scope, { path: '/' })
    page().drop()
    expect(await service.sweep()).toBe(1)
    await service.navigate(scope, { path: '/' })
    await service.onModuleDestroy()
    expect(page().close).toHaveBeenCalledOnce()
    expect(service.sessions).toBe(0)
  })
})
