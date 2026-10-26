import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createBrowserWorkerClient } from '@repo/browser-link'

import {
  BROWSER_TOOL_RESPONSE_MAX_BYTES,
  browserTaskCodes,
  browserTaskError,
  conflict,
  DomainError,
  type BrowserActionRequest,
  type BrowserToolResult,
  type KvSecret,
} from '@repo/domain'
import { newTurnKeys } from '@repo/turn-keys'
import { describe, expect, it, vi } from 'vitest'

import type { McpAccess } from '../access/mcp-access.ts'
import { contentMaskPath, ContentPrivacy } from '../privacy/content-privacy.ts'
import { McpWebService, type McpWebOptions } from './mcp-web.ts'
import type { McpWebAdmission, McpWebStore } from './mcp-web-store.ts'

const SITE = 'https://site.example.test/'
const PAGE = { pageId: 1, url: `${SITE}wp-admin/post-new.php`, title: 'Добавить запись' }

function scopeOf(): McpAccess {
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
    url: SITE,
    preview: null,
    requirements: { repository: false, browser: true },
  }
}

/** What the worker answers each tool with when a test does not say otherwise. */
function resultOf(request: BrowserActionRequest): BrowserToolResult {
  const { action } = request
  switch (action.tool) {
    case 'web_observe':
      return {
        tool: 'web_observe',
        observation: 'o1',
        page: PAGE,
        tabs: [PAGE],
        controller: 'agent',
        tree: '- textbox "Добавить заголовок" [ref=e3]',
        truncated: false,
      }
    case 'web_tab':
      return { tool: 'web_tab', page: PAGE, tabs: [PAGE] }
    case 'web_upload':
      return { tool: 'web_upload', page: PAGE, uploaded: action.attachmentIds.length }
    case 'web_wait':
      return { tool: 'web_wait', page: PAGE, matched: true }
    case 'web_help':
      return { tool: 'web_help', requested: true, reason: action.reason }
    case 'web_verify':
      return { tool: 'web_verify', objects: [], matched: true }
    case 'web_screenshot':
      return { tool: 'web_screenshot', page: PAGE, attached: true, number: 1 }
    default:
      return { tool: action.tool, page: PAGE }
  }
}

function fixture(options: { store?: Partial<McpWebStore>; service?: McpWebOptions } = {}) {
  const scope = scopeOf()
  const sessionId = randomUUID()
  const assignmentId = randomUUID()
  const clock = { now: 1_000_000 }
  const admission = (): McpWebAdmission => ({
    assignmentId,
    sessionId,
    now: new Date(clock.now),
    deadlineAt: new Date(clock.now + 600_000),
  })
  const base = {
    admit: vi.fn<McpWebStore['admit']>(async () => admission()),
    attachmentsOfTask: vi.fn<McpWebStore['attachmentsOfTask']>(async () => true),
  } satisfies McpWebStore
  const store = { ...base, ...options.store } as typeof base
  const worker = {
    action: vi.fn(
      async (
        _session: string,
        request: BrowserActionRequest,
        _options?: { signal?: AbortSignal },
      ) => resultOf(request),
    ),
  }
  // Vault: the contact map of the task (CAS).
  const records = new Map<string, KvSecret>()
  const secrets = {
    kvRead: vi.fn(async (path: string): Promise<KvSecret | null> => records.get(path) ?? null),
    kvWrite: vi.fn(async (path: string, data: Record<string, string>, opts?: { cas?: number }) => {
      const version = records.get(path)?.version ?? 0
      if (opts?.cas !== version) throw conflict('Synthetic CAS mismatch')
      records.set(path, { data: { ...data }, version: version + 1 })
      return { version: version + 1 }
    }),
  }
  const service = new McpWebService(
    { store, worker, privacy: new ContentPrivacy(secrets) },
    { now: () => clock.now, ...options.service },
  )
  /** A contact the task already knows, as the marker the agent saw. */
  const known = (value: string) => {
    const id = randomUUID()
    const path = contentMaskPath(scope)
    const entries = JSON.parse(records.get(path)?.data.entries ?? '[]') as unknown[]
    records.set(path, {
      version: (records.get(path)?.version ?? 0) + 1,
      data: { entries: JSON.stringify([...entries, { id, kind: 'email', value }]) },
    })
    return `[[raditi:email:${id}]]`
  }
  return { scope, sessionId, assignmentId, clock, store, worker, records, secrets, service, known }
}

/** The refusal of a call: its fixed code and fixed text, nothing else. */
const refused = (code: keyof typeof browserTaskCodes | 'CONTENT_PRIVACY_LIMIT') =>
  expect.objectContaining({ name: 'DomainError', code })

describe('the web tools of a browser task', () => {
  it('passes an action to the session of the task in the admitted turn', async () => {
    const { scope, service, worker, store, sessionId, assignmentId } = fixture()
    const answer = await service.call(scope, 'web_click', { observation: 'o1', ref: 'e3' })
    expect(store.admit).toHaveBeenCalledExactlyOnceWith(scope)
    expect(worker.action).toHaveBeenCalledExactlyOnceWith(
      sessionId,
      {
        taskId: scope.taskId,
        assignmentId,
        action: { tool: 'web_click', observation: 'o1', ref: 'e3' },
      },
      { signal: expect.any(AbortSignal) },
    )
    expect(answer).toEqual({ tool: 'web_click', page: PAGE })
  })

  it('asks the worker for a snapshot for the client and gives the model only its number', async () => {
    const { scope, service, worker } = fixture()
    const answer = await service.call(scope, 'web_screenshot', {})
    expect(worker.action.mock.calls[0]?.[1].action).toEqual({ tool: 'web_screenshot' })
    expect(answer).toEqual({ tool: 'web_screenshot', page: PAGE, attached: true, number: 1 })
  })

  it('refuses every call when the turn or the session is gone, before the worker', async () => {
    const { scope, service, worker } = fixture({
      store: {
        admit: vi.fn<McpWebStore['admit']>(async () => {
          throw new Error('connection to db.internal refused')
        }),
      },
    })
    const error = await service.call(scope, 'web_observe', {}).catch((caught: unknown) => caught)
    expect(error).toEqual(refused('BROWSER_SESSION_UNAVAILABLE'))
    expect((error as DomainError).message).toBe(
      browserTaskCodes.BROWSER_SESSION_UNAVAILABLE.message,
    )
    expect(JSON.stringify(error)).not.toContain('db.internal')
    expect(worker.action).not.toHaveBeenCalled()
  })

  it('refuses a turn credential in anything it would send, before the database', async () => {
    const { scope, service, store, worker } = fixture()
    const keys = newTurnKeys()
    for (const [tool, args] of [
      ['web_fill', { observation: 'o1', ref: 'e3', text: `ключ ${keys.llmApiKey}` }],
      ['web_type', { text: keys.mcpToken }],
      ['web_open', { url: `/wp-admin/?k=${keys.mcpToken}` }],
      ['web_dialog', { accept: true, text: keys.llmApiKey }],
      ['web_help', { reason: 'other', message: `Ключ ${keys.mcpToken}` }],
    ] as const)
      await expect(service.call(scope, tool, args as never)).rejects.toEqual(
        refused('BROWSER_ACTION_DENIED'),
      )
    expect(store.admit).not.toHaveBeenCalled()
    expect(worker.action).not.toHaveBeenCalled()
  })

  it("sends only files of the task's messages", async () => {
    const { scope, service, store, worker } = fixture()
    const ids = [randomUUID(), randomUUID()]
    await service.call(scope, 'web_upload', { attachmentIds: ids })
    expect(store.attachmentsOfTask).toHaveBeenCalledWith(scope.taskId, ids)
    expect(worker.action.mock.calls[0]![1].action).toEqual({
      tool: 'web_upload',
      attachmentIds: ids,
    })
    store.attachmentsOfTask.mockResolvedValueOnce(false)
    await expect(
      service.call(scope, 'web_upload', { observation: 'o1', ref: 'e7', attachmentIds: ids }),
    ).rejects.toEqual(refused('BROWSER_ATTACHMENT_UNKNOWN'))
    expect(worker.action).toHaveBeenCalledTimes(1)
  })

  it('types the contacts the markers of the task hide, and refuses a marker it does not know', async () => {
    const { scope, service, worker, known } = fixture()
    const marker = known('anna@example.test')
    await service.call(scope, 'web_fill', {
      observation: 'o1',
      ref: 'e3',
      text: `Пишите: ${marker}`,
    })
    await service.call(scope, 'web_type', { text: marker })
    expect(worker.action.mock.calls.map((call) => call[1].action)).toEqual([
      { tool: 'web_fill', observation: 'o1', ref: 'e3', text: 'Пишите: anna@example.test' },
      { tool: 'web_type', text: 'anna@example.test' },
    ])
    await expect(
      service.call(scope, 'web_type', { text: `[[raditi:email:${randomUUID()}]]` }),
    ).rejects.toEqual(refused('BROWSER_ACTION_FAILED'))
    // What the agent waits for or asks the client keeps its markers: nothing of it reaches the site.
    await service.call(scope, 'web_help', { reason: 'confirm', message: `Ответить ${marker}?` })
    expect(worker.action.mock.calls.at(-1)![1].action).toEqual({
      tool: 'web_help',
      reason: 'confirm',
      message: `Ответить ${marker}?`,
    })
  })

  it('opens a path of the site on its own address and nothing off it', async () => {
    const { scope, service, worker } = fixture()
    await service.call(scope, 'web_open', { url: '/wp-admin/post-new.php' })
    await service.call(scope, 'web_open', { url: 'https://other.example.test/' })
    expect(worker.action.mock.calls.map((call) => call[1].action)).toEqual([
      { tool: 'web_open', url: `${SITE}wp-admin/post-new.php` },
      // A full address is the worker's to judge, with the hosts of the site.
      { tool: 'web_open', url: 'https://other.example.test/' },
    ])
    for (const url of ['//evil.example.test/', '/\\evil.example.test/', `/${'a'.repeat(2048)}`])
      await expect(service.call(scope, 'web_open', { url })).rejects.toEqual(
        refused('BROWSER_ADDRESS_DENIED'),
      )
    expect(worker.action).toHaveBeenCalledTimes(2)
  })

  it('hides contacts of the page from the model in every text it reads', async () => {
    const { scope, service, worker, records } = fixture()
    const at = `${SITE}wp-admin/edit.php?s=anna@example.test`
    worker.action.mockResolvedValueOnce({
      tool: 'web_observe',
      observation: 'o4',
      page: { pageId: 1, url: at, title: 'Записи — anna@example.test' },
      tabs: [{ pageId: 1, url: at, title: 'Записи — anna@example.test' }],
      controller: 'agent',
      tree: '- text "Автор: anna@example.test, +7 (999) 123-45-67" [ref=e5]',
      truncated: false,
      dialog: { kind: 'confirm', message: 'Написать anna@example.test?' },
      checkpoint: { kind: 'post', objectId: '79991234567', state: 'seen' },
    })
    const answer = await service.call(scope, 'web_observe', {})
    const text = JSON.stringify(answer)
    expect(text).not.toMatch(/anna@example\.test|123-45-67/)
    expect(text).toContain('[[raditi:email:')
    expect(text).toContain('[[raditi:phone:')
    // The words of the contract, ids and references are not texts of the page.
    expect(answer).toMatchObject({
      observation: 'o4',
      controller: 'agent',
      checkpoint: { kind: 'post', objectId: '79991234567', state: 'seen' },
    })
    expect(records.has(contentMaskPath(scope))).toBe(true)
    // One value is one marker wherever it stands.
    const markers = new Set(text.match(/\[\[raditi:email:[0-9a-f-]+\]\]/g))
    expect(markers.size).toBe(1)
  })

  it('masks what a check of the site reads: titles and addresses of the objects', async () => {
    const { scope, service, worker } = fixture()
    worker.action.mockResolvedValueOnce({
      tool: 'web_verify',
      matched: true,
      objects: [
        {
          kind: 'post',
          objectId: '12',
          state: 'verified',
          object: {
            kind: 'post',
            objectId: '12',
            title: 'Пишите на anna@example.test',
            status: 'publish',
            url: `${SITE}?p=12`,
            editUrl: `${SITE}wp-admin/post.php?post=12&action=edit`,
            images: 2,
            files: 1,
            featuredImage: true,
          },
        },
      ],
    })
    const answer = await service.call(scope, 'web_verify', { expect: 'publish' })
    expect(JSON.stringify(answer)).not.toContain('anna@example.test')
    expect(answer).toMatchObject({
      matched: true,
      objects: [{ objectId: '12', state: 'verified', object: { status: 'publish', images: 2 } }],
    })
  })

  it('gives the model no secret of an address, even from a worker that left one', async () => {
    const { scope, service, worker } = fixture()
    const reset = `${SITE}wp-login.php?action=rp&key=AbC123&login=admin`
    worker.action.mockResolvedValueOnce({
      tool: 'web_observe',
      observation: 'o2',
      page: { pageId: 1, url: reset, title: 'Новый пароль' },
      tabs: [
        { pageId: 1, url: reset, title: 'Новый пароль' },
        { pageId: 2, url: `${SITE}wp-admin/admin.php?page=crm#/subscribers/12`, title: 'CRM' },
      ],
      controller: 'agent',
      tree: '- link "В корзину" [ref=e7]:\n  - /url: post.php?post=12&action=trash&_wpnonce=0a1b2c',
      truncated: false,
    })
    const answer = await service.call(scope, 'web_observe', {})
    expect(answer).toMatchObject({
      page: { url: `${SITE}wp-login.php?action=rp&key=[hidden]&login=admin` },
      tabs: [{ url: expect.any(String) }, { url: `${SITE}wp-admin/admin.php?page=crm#[hidden]` }],
      tree: '- link "В корзину" [ref=e7]:\n  - /url: post.php?post=12&action=trash&_wpnonce=[hidden]',
    })
    expect(JSON.stringify(answer)).not.toMatch(/AbC123|0a1b2c|subscribers/)

    worker.action.mockResolvedValueOnce({
      tool: 'web_verify',
      matched: true,
      objects: [
        {
          kind: 'post',
          objectId: '12',
          state: 'verified',
          object: {
            kind: 'post',
            objectId: '12',
            title: 'Новость',
            status: 'draft',
            url: `${SITE}?p=12&preview=true&preview_nonce=f00d`,
            editUrl: `${SITE}wp-admin/post.php?post=12&action=edit`,
            images: 0,
            files: 0,
            featuredImage: false,
          },
        },
      ],
    })
    expect(await service.call(scope, 'web_verify', {})).toMatchObject({
      objects: [
        {
          object: {
            url: `${SITE}?p=12&preview=true&preview_nonce=[hidden]`,
            editUrl: `${SITE}wp-admin/post.php?post=12&action=edit`,
          },
        },
      ],
    })
  })

  it('refuses a page that writes a marker of the platform, and a full contact map', async () => {
    const { scope, service, worker, secrets } = fixture()
    worker.action.mockResolvedValueOnce({
      ...(resultOf({
        taskId: scope.taskId,
        assignmentId: randomUUID(),
        action: { tool: 'web_observe' },
      }) as Extract<BrowserToolResult, { tool: 'web_observe' }>),
      tree: `- text "[[raditi:email:${randomUUID()}]]"`,
    })
    await expect(service.call(scope, 'web_observe', {})).rejects.toEqual(
      refused('BROWSER_ACTION_FAILED'),
    )
    secrets.kvRead.mockRejectedValueOnce(new Error('vault.internal:8200 sealed'))
    worker.action.mockResolvedValueOnce({
      tool: 'web_open',
      page: { ...PAGE, title: 'Связь: anna@example.test' },
    })
    const unavailable = await service
      .call(scope, 'web_open', { url: '/' })
      .catch((caught: unknown) => caught)
    expect(unavailable).toEqual(refused('BROWSER_SESSION_UNAVAILABLE'))
    expect(JSON.stringify(unavailable)).not.toMatch(/vault|anna/)
  })

  it('answers a refusal of the worker with its fixed code and text, anything else as its own', async () => {
    const { scope, service, worker } = fixture()
    for (const code of [
      'BROWSER_USER_IN_CONTROL',
      'BROWSER_STALE_OBSERVATION',
      'BROWSER_CHECKPOINT_UNVERIFIED',
      'BROWSER_UPLOAD_REFUSED',
    ] as const) {
      worker.action.mockRejectedValueOnce(browserTaskError(code))
      const error = await service
        .call(scope, 'web_click', { observation: 'o1', ref: 'e3' })
        .catch((caught: unknown) => caught)
      expect(error).toEqual(refused(code))
      expect((error as DomainError).message).toBe(browserTaskCodes[code].message)
    }
    // Another refusal of the worker (a wrong token, a bad request) leaves the browser out of reach.
    worker.action.mockRejectedValueOnce(
      new DomainError('UNAUTHORIZED', 'The browser worker refused the request', 401),
    )
    await expect(service.call(scope, 'web_observe', {})).rejects.toEqual(
      refused('BROWSER_SESSION_UNAVAILABLE'),
    )
    // The budget of the call ran out: the action may have happened, the agent looks again.
    worker.action.mockRejectedValueOnce(
      new DOMException('The operation timed out.', 'TimeoutError'),
    )
    await expect(service.call(scope, 'web_observe', {})).rejects.toEqual(refused('BROWSER_TIMEOUT'))
  })

  it('gives the worker what is left of the call and of the turn', async () => {
    const { scope, service, worker, store, clock, sessionId, assignmentId } = fixture({
      service: { callBudgetMs: 50_000 },
    })
    let signal: AbortSignal | undefined
    worker.action.mockImplementationOnce(async (_session, request, options) => {
      signal = options?.signal
      return resultOf(request)
    })
    await service.call(scope, 'web_observe', {})
    expect(signal?.aborted).toBe(false)
    // The turn ends in half a second: no action starts in it.
    store.admit.mockResolvedValueOnce({
      assignmentId,
      sessionId,
      now: new Date(clock.now),
      deadlineAt: new Date(clock.now + 500),
    })
    await expect(service.call(scope, 'web_observe', {})).rejects.toEqual(
      refused('BROWSER_SESSION_UNAVAILABLE'),
    )
    expect(worker.action).toHaveBeenCalledTimes(1)
  })

  it('runs one call of a turn at a time and admits a waiting one again', async () => {
    const { scope, service, worker, store } = fixture()
    let release!: () => void
    const order: string[] = []
    worker.action.mockImplementationOnce(async (_session, request) => {
      order.push('first:start')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      order.push('first:end')
      return resultOf(request)
    })
    worker.action.mockImplementationOnce(async (_session, request) => {
      order.push('second')
      return resultOf(request)
    })
    const first = service.call(scope, 'web_click', { observation: 'o1', ref: 'e3' })
    const second = service.call(scope, 'web_observe', {})
    await vi.waitFor(() => expect(order).toEqual(['first:start']))
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
    // Each admitted before the lock; the one that waited once more under it.
    expect(store.admit).toHaveBeenCalledTimes(3)
    // A waiting call whose turn ended meanwhile does not reach the worker.
    let started = false
    worker.action.mockImplementationOnce(async (_session, request) => {
      started = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return resultOf(request)
    })
    const third = service.call(scope, 'web_click', { observation: 'o1', ref: 'e3' })
    const fourth = service.call(scope, 'web_observe', {})
    await vi.waitFor(() => {
      expect(started).toBe(true)
      expect(store.admit).toHaveBeenCalledTimes(5)
    })
    store.admit.mockRejectedValueOnce(new Error('turn ended'))
    release()
    await third
    await expect(fourth).rejects.toEqual(refused('BROWSER_SESSION_UNAVAILABLE'))
    expect(worker.action).toHaveBeenCalledTimes(3)
  })

  it('keeps an answer within 64 KiB, cut where nothing is split, and says so', async () => {
    const { scope, service, worker } = fixture()
    // One contact on every line: its marker is longer than it, so the answer grows past the bound.
    const line = (index: number) => `- text "Строка ${index}: пишите anna@example.test"`
    const tree = Array.from({ length: 1200 }, (_, index) => line(index)).join('\n')
    worker.action.mockResolvedValueOnce({
      tool: 'web_observe',
      observation: 'o9',
      page: PAGE,
      tabs: [PAGE],
      controller: 'agent',
      tree,
      truncated: false,
    })
    const answer = (await service.call(scope, 'web_observe', {})) as { tree: string }
    const size = Buffer.byteLength(JSON.stringify(answer))
    expect(size).toBeLessThanOrEqual(BROWSER_TOOL_RESPONSE_MAX_BYTES)
    expect(answer).toMatchObject({ observation: 'o9', truncated: true })
    // Whole lines, every marker whole.
    for (const kept of answer.tree.split('\n'))
      expect(kept).toMatch(/\[\[raditi:email:[0-9a-f-]+\]\]"$/)
    expect(answer.tree).not.toContain('@example.test')
    const object = (index: number) => ({
      kind: 'post' as const,
      objectId: String(index + 1),
      state: 'verified' as const,
      object: {
        kind: 'post' as const,
        objectId: String(index + 1),
        title: 'Заголовок '.repeat(99),
        status: 'draft' as const,
        url: `${SITE}?p=${index + 1}&${'x'.repeat(1900)}`,
        editUrl: `${SITE}wp-admin/post.php?post=${index + 1}&${'y'.repeat(1900)}`,
        images: 0,
        files: 0,
        featuredImage: false,
      },
    })
    worker.action.mockResolvedValueOnce({
      tool: 'web_verify',
      matched: false,
      objects: Array.from({ length: 32 }, (_, index) => object(index)),
    })
    const verified = (await service.call(scope, 'web_verify', {})) as { objects: unknown[] }
    expect(Buffer.byteLength(JSON.stringify(verified))).toBeLessThanOrEqual(
      BROWSER_TOOL_RESPONSE_MAX_BYTES,
    )
    expect(verified).toMatchObject({ matched: false, truncated: true })
    expect(verified.objects.length).toBeGreaterThan(0)
    expect(verified.objects.length).toBeLessThan(32)
  })

  it('reaches the worker with its token, the session of the task and the turn, and its code', async () => {
    const token = 'w'.repeat(48)
    const seen: Array<{ url?: string; authorization?: string; body: unknown }> = []
    const answers = [
      {
        ok: true,
        result: {
          tool: 'web_observe',
          observation: 'o1',
          page: PAGE,
          tabs: [PAGE],
          controller: 'agent',
          tree: '- heading "Записи" [level=1]',
          truncated: false,
        },
      },
      { ok: false, code: 'BROWSER_USER_IN_CONTROL' },
    ]
    const read = async (incoming: IncomingMessage) => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(chunk as Buffer)
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    }
    const server = createServer((incoming, response) => {
      void read(incoming).then((body) => {
        seen.push({ url: incoming.url, authorization: incoming.headers.authorization, body })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(answers.shift()))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { scope, store, sessionId, assignmentId } = fixture()
      const { port } = server.address() as AddressInfo
      const service = new McpWebService({
        store,
        worker: createBrowserWorkerClient({ baseUrl: `http://127.0.0.1:${port}`, token }),
        privacy: new ContentPrivacy({
          kvRead: async () => null,
          kvWrite: async () => ({ version: 1 }),
        }),
      })
      expect(await service.call(scope, 'web_observe', {})).toMatchObject({
        observation: 'o1',
        tree: '- heading "Записи" [level=1]',
      })
      await expect(service.call(scope, 'web_observe', {})).rejects.toEqual(
        refused('BROWSER_USER_IN_CONTROL'),
      )
      expect(seen[0]).toEqual({
        url: `/v1/sessions/${sessionId}/actions`,
        authorization: `Bearer ${token}`,
        body: { taskId: scope.taskId, assignmentId, action: { tool: 'web_observe' } },
      })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
