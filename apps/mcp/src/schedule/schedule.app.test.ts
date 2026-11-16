import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { ReservedScheduleChange } from '@repo/db'
import {
  DomainError,
  resolveScheduleToolTriggers,
  scheduleLimitReached,
  scheduleTemplatePlaceholder,
  type ScheduleTrigger,
} from '@repo/domain'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MCP_ACCESS, type McpAccessStore, type McpTurnAccess } from '../access/mcp-access.ts'
import { AppModule } from '../app.module.ts'
import type { McpConfig } from '../config/config.ts'
import { McpPagesService, type McpPagesStore } from '../pages/pages-service.ts'
import { MCP_PAGES } from '../pages/pages.tokens.ts'
import { MCP_ENDPOINT } from '../server/mcp-runtime.ts'
import { mountMcp } from '../server/mount-mcp.ts'
import { fakeInfra, testMcpConfig } from '../testing/fakes.ts'
import {
  McpScheduleService,
  SCHEDULE_LIST_MAX_BYTES,
  type McpListedSchedule,
  type McpScheduleStore,
} from './schedule-service.ts'
import { MCP_SCHEDULE } from './schedule.tokens.ts'

const token = `mcp_${'c'.repeat(64)}`
const scheduleId = '01960000-0000-7000-8000-0000000000a1'
const reservedId = '01960000-0000-7000-8000-0000000000a2'
const authorId = '01960000-0000-7000-8000-0000000000a3'
// 15 November 2026, 10:05 in Moscow.
const NOW = new Date('2026-11-15T07:05:00Z')

/** A chat with the browser: the turn the role admitted, in its author's personal workspace. */
const browserChat: McpTurnAccess = {
  keyId: '01960000-0000-7000-8000-000000000021',
  taskId: '01960000-0000-7000-8000-000000000022',
  workspaceId: '01960000-0000-7000-8000-000000000023',
  sessionId: 'synthetic',
  turn: 3,
  firstEpoch: 1,
  epoch: 1,
  requirements: { repository: false, browser: true },
  unattended: false,
}
/** A chat without the browser. */
const plainChat: McpTurnAccess = {
  ...browserChat,
  requirements: { repository: false, browser: false },
}

const weekdays: ScheduleTrigger[] = [{ kind: 'weekdays', time: '09:00' }]

const listed = (extra: Partial<McpListedSchedule> = {}): McpListedSchedule => ({
  id: scheduleId,
  name: 'Курс валют',
  instructions: 'Пришли курс доллара, евро и юаня по ЦБ на сегодня.',
  effort: 'low',
  triggers: weekdays,
  timezone: 'Europe/Moscow',
  enabled: true,
  notify: true,
  pausedReason: null,
  nextRunAt: new Date('2026-11-16T06:00:00Z'),
  lastRun: {
    dueAt: new Date('2026-11-13T06:00:00Z'),
    trigger: 'schedule',
    status: 'started',
    reason: null,
  },
  ...extra,
})

/** What the db function would reserve: the single runs from now resolved in the task's zone. */
function reservedOf(input: Parameters<McpScheduleStore['reserve']>[0]): ReservedScheduleChange {
  const { change, now } = input
  if (change.kind === 'delete')
    return {
      reservationId: reservedId,
      kind: 'delete',
      scheduleId: change.scheduleId ?? null,
      fields: null,
      nextRunAt: null,
      cancelled: change.reservedId !== undefined,
    }
  const timezone = change.timezone ?? 'Europe/Moscow'
  const triggers = resolveScheduleToolTriggers(change.triggers ?? weekdays, timezone, now)
  return {
    reservationId: reservedId,
    kind: change.kind,
    scheduleId: change.kind === 'update' ? (change.scheduleId ?? null) : null,
    fields: {
      name: change.name ?? 'Курс валют',
      instructions: change.instructions ?? 'Пришли курс доллара.',
      effort: change.effort ?? 'high',
      triggers,
      timezone,
      notify: change.notify ?? true,
      enabled: change.kind === 'update' ? (change.enabled ?? true) : true,
    },
    nextRunAt:
      triggers[0]?.kind === 'once'
        ? new Date(now.getTime() + 30 * 60_000)
        : new Date('2026-11-16T06:00:00Z'),
    cancelled: false,
  }
}

function fakeStore() {
  return {
    author: vi.fn<McpScheduleStore['author']>(async () => ({
      userId: authorId,
      timezone: 'Europe/Moscow',
    })),
    list: vi.fn<McpScheduleStore['list']>(async () => [listed()]),
    pending: vi.fn<McpScheduleStore['pending']>(async () => []),
    reserve: vi.fn<McpScheduleStore['reserve']>(async (input) => reservedOf(input)),
  } satisfies McpScheduleStore
}

/** A store of the pages: a deletion, a publication and an edit are asked of it here. */
function pagesStore() {
  const never = vi.fn(async () => {
    throw new Error('not asked of this test')
  })
  return {
    reserve: vi.fn(async () => ({
      pageId: scheduleId,
      slug: 'akcii',
      path: '/',
      treeId: reservedId,
      version: 3,
    })),
    documentTitle: never,
    list: vi.fn(async () => []),
    read: vi.fn(async () => ({
      pageId: scheduleId,
      kind: 'page',
      version: 2,
      documentId: null,
      format: 'html' as const,
      text: '<h1>Старая цена</h1>',
    })),
    putFile: never,
    files: never,
    deleteFile: never,
    change: vi.fn(async (input: { change: { pageId: string } }) => ({
      reservationId: reservedId,
      pageId: input.change.pageId,
      pages: 1,
    })),
  }
}

let app: INestApplication | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await app?.close()
  app = undefined
})

const pagesAddress = { baseDomain: 'pages.localhost', scheme: 'http' as const, port: 8092 }

async function start(
  scope: McpTurnAccess = browserChat,
  store = fakeStore(),
  config: McpConfig = testMcpConfig(),
  pages = pagesStore(),
) {
  const access: McpAccessStore = {
    authenticate: async (value) => (value === token ? scope : null),
  }
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(PRISMA)
    .useValue(fakeInfra().prisma)
    .overrideProvider(SECRET_STORE)
    .useValue(fakeInfra().secrets)
    .overrideProvider(MCP_ACCESS)
    .useValue(access)
    .overrideProvider(MCP_SCHEDULE)
    .useValue(new McpScheduleService({ store, now: () => NOW }))
  if (config.pages)
    builder
      .overrideProvider(MCP_PAGES)
      .useValue(
        new McpPagesService({ store: pages as unknown as McpPagesStore, address: pagesAddress }),
      )
  app = (await builder.compile()).createNestApplication({ logger: false })
  await mountMcp(app)
  await app.listen(0, '127.0.0.1')
  return { server: app.getHttpServer(), store, pages }
}

const post = (server: unknown, body: object) =>
  request(server as Parameters<typeof request>[0])
    .post(MCP_ENDPOINT)
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .set('mcp-protocol-version', '2025-06-18')
    .send(body)

const call = (name: string, args?: unknown) => ({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name, ...(args === undefined ? {} : { arguments: args }) },
})

const listTools = async (server: unknown) =>
  (await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result.tools as {
    name: string
    description: string
    annotations: Record<string, boolean>
    inputSchema: { properties?: Record<string, unknown>; required?: string[] }
  }[]

const scheduleTools = async (server: unknown) =>
  (await listTools(server)).map((tool) => tool.name).filter((name) => name.startsWith('schedule_'))

/** The text of a tool's answer, and whether it is an error. */
const answer = (res: request.Response) => ({
  status: res.status,
  isError: res.body.result?.isError === true,
  value: JSON.parse(res.body.result.content[0].text) as Record<string, unknown>,
})

const create = {
  name: 'Курс валют',
  instructions:
    'Пришли курс доллара, евро и юаня по ЦБ на сегодня и насколько он изменился со вчера.',
  effort: 'low',
  triggers: weekdays,
  confirmedByClient: true,
}

describe('the scheduled tasks through the gateway (plan 82, Зп31–Зп34)', () => {
  it('are offered to every turn, with the list read-only and the deletion destructive', async () => {
    const { server } = await start()
    const tools = await listTools(server)
    const of = (name: string) => tools.find((tool) => tool.name === name)!
    expect(await scheduleTools(server)).toEqual([
      'schedule_list',
      'schedule_create',
      'schedule_update',
      'schedule_delete',
    ])
    expect(of('schedule_list').annotations).toMatchObject({ readOnlyHint: true })
    for (const name of ['schedule_create', 'schedule_update'])
      expect(of(name).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(of('schedule_delete').annotations).toMatchObject({ destructiveHint: true })
    // The model is told what it needs, in English: the client's agreement and the end of the turn.
    for (const name of ['schedule_create', 'schedule_update', 'schedule_delete']) {
      expect(of(name).description).toMatch(/confirmedByClient: true/)
      expect(of(name).description).toMatch(/when this turn ends/)
      expect(of(name).description).toMatch(/never report it as a success/)
      expect(of(name).inputSchema.required).toContain('confirmedByClient')
    }
    expect(of('schedule_create').description).toMatch(/client's own request/)
    expect(Object.keys(of('schedule_create').inputSchema.properties ?? {}).sort()).toEqual([
      'confirmedByClient',
      'effort',
      'instructions',
      'name',
      'notify',
      'timezone',
      'triggers',
    ])
  })

  it('offers only schedule_list to a pass of a scheduled run without its client (Зп32)', async () => {
    const unattended = { ...browserChat, unattended: true }
    const { server, store } = await start(unattended)
    expect(await scheduleTools(server)).toEqual(['schedule_list'])
    // A change is answered as a refusal of its tool, before any tool sees it.
    for (const [name, args] of [
      ['schedule_create', create],
      ['schedule_update', { scheduleId, enabled: false, confirmedByClient: true }],
      ['schedule_delete', { scheduleId, confirmedByClient: true }],
    ] as const) {
      const res = answer(await post(server, call(name, args)))
      expect(res).toMatchObject({ status: 200, isError: true })
      expect(res.value).toMatchObject({ ok: false, code: 'SCHEDULE_FORBIDDEN' })
      expect(res.value.message).toMatch(/nobody can confirm/)
    }
    expect(store.reserve).not.toHaveBeenCalled()
    // The list still reads.
    const list = answer(await post(server, call('schedule_list', {})))
    expect(list).toMatchObject({ status: 200, isError: false })
    expect(list.value.schedules).toHaveLength(1)
  })

  it('refuses any call with confirmedByClient in a pass without the client: page_delete too', async () => {
    const withPages = { ...testMcpConfig(), pages: pagesAddress }
    const deletion = call('page_delete', { pageIds: [scheduleId], confirmedByClient: true })
    const unattended = await start({ ...plainChat, unattended: true }, fakeStore(), withPages)
    const res = answer(await post(unattended.server, deletion))
    expect(res).toMatchObject({
      status: 200,
      isError: true,
      value: { ok: false, code: 'SCHEDULE_FORBIDDEN' },
    })
    expect(unattended.pages.change).not.toHaveBeenCalled()
    // What needs no word goes on: the pages are listed.
    expect(answer(await post(unattended.server, call('page_list', {}))).isError).toBe(false)
    await app?.close()
    app = undefined
    // The same chat once its client wrote: the deletion is reserved, as ever.
    const attended = await start({ ...plainChat, unattended: false }, fakeStore(), withPages)
    expect(answer(await post(attended.server, deletion)).value).toMatchObject({
      live: 'when this turn ends',
    })
    expect(attended.pages.change).toHaveBeenCalledTimes(1)
  })

  it('changes no page in a pass without the client: its visitors would see it unread (Зп28)', async () => {
    const withPages = { ...testMcpConfig(), pages: pagesAddress }
    const publication = call('page_publish', {
      file: 'akcii.html',
      title: 'Акции',
      pageId: scheduleId,
      expectedVersion: 2,
    })
    const edit = call('page_edit', {
      pageId: scheduleId,
      expectedVersion: 2,
      edits: [{ old: 'Старая цена', new: 'Новая цена' }],
    })
    const pageTools = async (server: unknown) =>
      (await listTools(server)).map((tool) => tool.name).filter((name) => name.startsWith('page_'))
    const unattended = await start({ ...browserChat, unattended: true }, fakeStore(), withPages)
    // The pages are there to read; nothing that changes them is offered.
    expect((await pageTools(unattended.server)).sort()).toEqual([
      'page_files',
      'page_list',
      'page_read',
      'page_tree',
    ])
    // Called anyway — the text of a page it read may say so — each is its tool's refusal.
    for (const body of [publication, edit]) {
      const res = answer(await post(unattended.server, body))
      expect(res).toMatchObject({ status: 200, isError: true })
      expect(res.value).toMatchObject({ ok: false, code: 'SCHEDULE_FORBIDDEN' })
      expect(res.value.message).toMatch(/publish or change no page/)
    }
    expect(unattended.pages.reserve).not.toHaveBeenCalled()
    expect(unattended.pages.read).not.toHaveBeenCalled()
    expect(unattended.pages.change).not.toHaveBeenCalled()
    await app?.close()
    app = undefined
    // The same chat once its client wrote: both are reserved for the end of the turn, as ever.
    const attended = await start({ ...browserChat, unattended: false }, fakeStore(), withPages)
    expect(await pageTools(attended.server)).toEqual(
      expect.arrayContaining(['page_publish', 'page_edit', 'page_file_put', 'page_restore']),
    )
    expect(answer(await post(attended.server, publication))).toMatchObject({
      isError: false,
      value: { pageId: scheduleId, version: 3 },
    })
    expect(answer(await post(attended.server, edit)).isError).toBe(false)
    expect(attended.pages.reserve).toHaveBeenCalledTimes(1)
    expect(attended.pages.change).toHaveBeenCalledTimes(1)
  })

  it('lists the tasks of the chat’s author, the time and the client’s zone (Зп54)', async () => {
    const store = fakeStore()
    store.pending.mockResolvedValueOnce([
      { reservedId, kind: 'create', scheduleId: null, name: 'Идеи для постов' },
    ])
    const { server } = await start(browserChat, store)
    const res = answer(await post(server, call('schedule_list')))
    expect(res.isError).toBe(false)
    expect(res.value).toEqual({
      ok: true,
      now: NOW.toISOString(),
      timezone: 'Europe/Moscow',
      clientTime: '2026-11-15 10:05, Sunday',
      schedules: [
        {
          scheduleId,
          name: 'Курс валют',
          instructions: 'Пришли курс доллара, евро и юаня по ЦБ на сегодня.',
          effort: 'low',
          triggers: weekdays,
          timezone: 'Europe/Moscow',
          scheduleText: 'По будням в 9:00',
          state: 'enabled',
          nextRunAt: '2026-11-16T06:00:00.000Z',
          nextRunText: 'завтра в 9:00',
          notify: true,
          lastRun: {
            at: '2026-11-13T06:00:00.000Z',
            trigger: 'schedule',
            status: 'started',
            reason: null,
          },
        },
      ],
      reservedThisTurn: [{ reservedId, kind: 'create', scheduleId: null, name: 'Идеи для постов' }],
    })
    // Whose and where come from the admitted turn: its author and their workspace.
    expect(store.author).toHaveBeenCalledWith(browserChat.taskId)
    expect(store.list).toHaveBeenCalledWith({
      userId: authorId,
      workspaceId: browserChat.workspaceId,
    })
    expect(store.pending).toHaveBeenCalledWith(browserChat.taskId, 3)
  })

  it('lists the tasks in a chat without the browser alike, in Moscow without a zone', async () => {
    const store = fakeStore()
    store.author.mockResolvedValue({ userId: authorId, timezone: null })
    store.list.mockResolvedValue([
      listed({
        enabled: false,
        pausedReason: 'completed',
        nextRunAt: null,
        triggers: null,
        timezone: 'Asia/Novosibirsk',
      }),
      // A zone this engine does not know: that task without its moment, not the list without it.
      listed({ timezone: 'Mars/Olympus' }),
    ])
    const { server } = await start(plainChat, store)
    const res = answer(await post(server, call('schedule_list', {})))
    expect(res.value).toMatchObject({ timezone: 'Europe/Moscow' })
    expect(res.value.schedules).toEqual([
      expect.objectContaining({
        state: 'completed',
        scheduleText: null,
        nextRunAt: null,
        nextRunText: null,
      }),
      expect.objectContaining({ state: 'enabled', nextRunText: null }),
    ])
    expect(store.list).toHaveBeenCalledWith({
      userId: authorId,
      workspaceId: plainChat.workspaceId,
    })
    // A chat whose author is gone has nobody's tasks.
    store.author.mockResolvedValueOnce(null)
    expect(answer(await post(server, call('schedule_list', {}))).value).toMatchObject({
      ok: false,
      code: 'SCHEDULE_FORBIDDEN',
    })
  })

  it('keeps a long list within the bound of an answer, cut and said so', async () => {
    const store = fakeStore()
    const long = 'Проверьте страницу каталога и опишите, что изменилось. '.repeat(70)
    store.list.mockResolvedValue(
      Array.from({ length: 60 }, (_, at) =>
        listed({
          id: `01960000-0000-7000-8000-${String(at).padStart(12, '0')}`,
          instructions: long,
        }),
      ),
    )
    const { server } = await start(browserChat, store)
    const res = await post(server, call('schedule_list', {}))
    expect(Buffer.byteLength(res.body.result.content[0].text)).toBeLessThanOrEqual(
      SCHEDULE_LIST_MAX_BYTES,
    )
    const value = JSON.parse(res.body.result.content[0].text)
    expect(value.schedules[0]).toMatchObject({ instructionsCut: true })
    expect([...value.schedules[0].instructions]).toHaveLength(400)
    expect(value).toMatchObject({ truncated: true, total: 60 })
  })

  it('reserves a task of the chat’s author from the admitted turn (Зп33)', async () => {
    const { server, store } = await start()
    const res = answer(await post(server, call('schedule_create', create)))
    expect(res).toMatchObject({ status: 200, isError: false })
    expect(res.value).toEqual({
      ok: true,
      reservedId,
      action: 'create',
      scheduleId: null,
      name: 'Курс валют',
      scheduleText: 'По будням в 9:00',
      timezone: 'Europe/Moscow',
      enabled: true,
      nextRunAt: '2026-11-16T06:00:00.000Z',
      nextRunText: 'завтра в 9:00',
      live: 'when this turn ends',
      warnings: [expect.stringMatching(/Задача появится, как только я закончу ответ/)],
    })
    const { confirmedByClient: _confirmed, ...change } = create
    expect(store.reserve).toHaveBeenCalledWith({
      workspaceId: browserChat.workspaceId,
      taskId: browserChat.taskId,
      turnNo: 3,
      change: { kind: 'create', ...change },
      now: NOW,
    })
  })

  it('passes a single run from now on for the server to count, in the zone of the task', async () => {
    const { server, store } = await start()
    const res = answer(
      await post(
        server,
        call('schedule_create', {
          ...create,
          triggers: [{ kind: 'once', inMinutes: 30 }],
          timezone: 'Asia/Novosibirsk',
        }),
      ),
    )
    expect(store.reserve.mock.calls[0]![0].change).toMatchObject({
      triggers: [{ kind: 'once', inMinutes: 30 }],
      timezone: 'Asia/Novosibirsk',
    })
    // 10:35 in Moscow is 14:35 in Novosibirsk.
    expect(res.value).toMatchObject({
      scheduleText: 'Один раз: 15 ноября 2026, в 14:35 (по времени Новосибирска)',
      nextRunText: 'сегодня в 14:35',
    })
  })

  it('takes no change the client did not confirm, nor one with a key of its own', async () => {
    const { server, store } = await start()
    for (const args of [
      { ...create, confirmedByClient: undefined },
      { ...create, confirmedByClient: false },
      { ...create, workspaceId: browserChat.workspaceId },
      { ...create, chatId: browserChat.taskId },
    ])
      expect((await post(server, call('schedule_create', args))).status, JSON.stringify(args)).toBe(
        400,
      )
    expect(
      (await post(server, call('schedule_update', { scheduleId, enabled: false }))).status,
    ).toBe(400)
    expect((await post(server, call('schedule_delete', { scheduleId }))).status).toBe(400)
    expect(store.reserve).not.toHaveBeenCalled()
  })

  it('tells refusals of the store and of the schedule as results the agent explains', async () => {
    const store = fakeStore()
    store.reserve
      .mockRejectedValueOnce(scheduleLimitReached())
      .mockRejectedValueOnce(new DomainError('SCHEDULE_CHANGE_LIMIT', 'Не больше 5', 409))
      .mockRejectedValueOnce(new DomainError('TASK_TEXT_HAS_SECRET', 'A password or a key', 400))
    const { server } = await start(browserChat, store)
    const results = []
    for (const code of ['SCHEDULE_LIMIT', 'SCHEDULE_CHANGE_LIMIT', 'TASK_TEXT_HAS_SECRET']) {
      const res = answer(await post(server, call('schedule_create', create)))
      expect(res).toMatchObject({ status: 200, isError: true, value: { ok: false, code } })
      results.push(res.value)
    }
    // Instructions with the place of a template left for the client's words (Зп59): the store
    // refuses them, and the agent hears it as its tool's result — on a creation and a change.
    const unfilled = 'Открой сайт [впишите адрес сайта] и проверь главную.'
    for (const body of [
      call('schedule_create', { ...create, instructions: unfilled }),
      call('schedule_update', { scheduleId, instructions: unfilled, confirmedByClient: true }),
    ]) {
      store.reserve.mockRejectedValueOnce(scheduleTemplatePlaceholder())
      expect(answer(await post(server, body))).toMatchObject({
        status: 200,
        isError: true,
        value: {
          ok: false,
          code: 'SCHEDULE_TEMPLATE_PLACEHOLDER',
          message: 'Замените текст в квадратных скобках своим',
        },
      })
    }
    expect(store.reserve.mock.calls.slice(-2).map((each) => each[0].change)).toEqual([
      expect.objectContaining({ kind: 'create', instructions: unfilled }),
      { kind: 'update', scheduleId, instructions: unfilled },
    ])
    // The words of the refusal as the domain has them: the client's, which the agent retells.
    expect(results[0]).toEqual({
      ok: false,
      code: 'SCHEDULE_LIMIT',
      message: 'Включено 20 задач — больше нельзя. Приостановите или удалите одну',
    })
    // Runs closer than an hour: the client's words, and nothing reserved for them.
    store.reserve.mockClear()
    const often = answer(
      await post(
        server,
        call('schedule_create', {
          ...create,
          triggers: [
            { kind: 'daily', time: '09:00' },
            { kind: 'daily', time: '09:30' },
          ],
        }),
      ),
    )
    expect(often).toMatchObject({
      status: 200,
      isError: true,
      value: {
        ok: false,
        code: 'SCHEDULE_TOO_OFTEN',
        message: 'Запуски одной задачи — не чаще раза в час',
      },
    })
    expect(store.reserve).not.toHaveBeenCalled()
    // An outage of the database is no refusal the agent can explain: the call fails.
    store.reserve.mockRejectedValueOnce(new Error('connection lost'))
    const failed = await post(server, call('schedule_create', create))
    expect(JSON.stringify(failed.body)).not.toMatch(/"ok":true/)
  })

  it('changes or cancels a reservation of this turn by its reservedId', async () => {
    const { server, store } = await start()
    const updated = answer(
      await post(
        server,
        call('schedule_update', {
          reservedId,
          triggers: [{ kind: 'weekly', time: '16:00', days: [5] }],
          confirmedByClient: true,
        }),
      ),
    )
    expect(updated.value).toMatchObject({
      ok: true,
      reservedId,
      action: 'update',
      scheduleText: 'Еженедельно: пятница, в 16:00',
      live: 'when this turn ends',
    })
    expect(store.reserve.mock.calls[0]![0].change).toEqual({
      kind: 'update',
      reservedId,
      triggers: [{ kind: 'weekly', time: '16:00', days: [5] }],
    })
    const cancelled = answer(
      await post(server, call('schedule_delete', { reservedId, confirmedByClient: true })),
    )
    expect(cancelled.value).toMatchObject({ ok: true, reservedId, cancelled: true })
    const deleted = answer(
      await post(server, call('schedule_delete', { scheduleId, confirmedByClient: true })),
    )
    expect(deleted.value).toMatchObject({
      ok: true,
      action: 'delete',
      scheduleId,
      live: 'when this turn ends',
    })
    expect(store.reserve.mock.calls.map((each) => each[0].change)).toEqual([
      expect.objectContaining({ kind: 'update' }),
      { kind: 'delete', reservedId },
      { kind: 'delete', scheduleId },
    ])
  })

  it('pauses and resumes a task by enabled', async () => {
    const { server, store } = await start()
    const paused = answer(
      await post(
        server,
        call('schedule_update', { scheduleId, enabled: false, confirmedByClient: true }),
      ),
    )
    expect(paused.value).toMatchObject({ ok: true, enabled: false, scheduleId })
    expect(store.reserve.mock.calls[0]![0].change).toEqual({
      kind: 'update',
      scheduleId,
      enabled: false,
    })
  })
})
