import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { createPrismaClient, type Prisma, type PrismaClient, type User } from '@repo/db'
import { feedRowSchema, legalDocuments, type ObjectStorage, type SecretStore } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import type { ChatContext } from '../services/chat/context.ts'

// The chat from the database to the screen, measured (infra/dev/perf-verify/README.md): the
// procedures the page calls, on synthetic chats of realistic volume, with the statements
// PostgreSQL ran for each call (pg_stat_statements). Runs only under infra/dev/perf-verify/perf.mjs,
// which owns a disposable database: RADITI_PERF_BENCH=1 and DATABASE_URL.

const databaseUrl = process.env.DATABASE_URL
const enabled = process.env.RADITI_PERF_BENCH === '1' && Boolean(databaseUrl)

const SITE_URL = 'https://kofeinya.example.ru'

/** The volume of the chats: turns, journal rows a turn leaves, and repeats of each measurement. */
const VOLUME = Object.freeze({
  shortTurns: 3,
  longTurns: 120,
  /** Rows `turn.output` a finished turn left: about a minute and a half of the agent writing. */
  outputPerTurn: 200,
  lifecyclePerTurn: 8,
  /** Turns already done in each running chat, and the rows its running turn wrote so far. */
  runningDone: 40,
  runningOutput: 600,
  runningChats: 8,
  repeats: { open: 15, poll: 60, activity: 10, concurrentRounds: 20 },
})

type Caller = ReturnType<typeof createCaller>

interface Sample {
  ms: number
  statements: number
  dataStatements: number
  dbMs: number
  rows: number
  cpuMs: number
  calls: number
}

const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}
const round = (value: number) => Math.round(value * 100) / 100

function summarize(samples: readonly Sample[]) {
  const of = (key: keyof Sample) => samples.map((sample) => sample[key])
  const mean = (key: keyof Sample) => round(of(key).reduce((a, b) => a + b, 0) / samples.length)
  return {
    n: samples.length,
    ms: { p50: round(percentile(of('ms'), 50)), p95: round(percentile(of('ms'), 95)) },
    statements: mean('statements'),
    dataStatements: mean('dataStatements'),
    dbMs: mean('dbMs'),
    rows: mean('rows'),
    cpuMs: mean('cpuMs'),
    calls: mean('calls'),
  }
}

describe.skipIf(!enabled)('the chat from the database to the screen (perf)', () => {
  let db: PrismaClient
  let owner: User
  let caller: Caller
  const chats = { short: '', long: '', running: [] as string[] }
  const report: Record<string, unknown> = {}

  /** Statements PostgreSQL ran since the last reset, without those of this measurement itself. */
  async function statements() {
    const [row] = await db.$queryRawUnsafe<
      Array<{ calls: bigint; data: bigint; exec: number; rows: bigint }>
    >(`SELECT coalesce(sum(calls), 0)::bigint AS calls,
        coalesce(sum(calls) FILTER (WHERE query ~* '^\\s*(select|insert|update|delete|with)'), 0)::bigint AS data,
        coalesce(sum(total_exec_time), 0)::float8 AS exec,
        coalesce(sum(rows), 0)::bigint AS rows
      FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%'`)
    return {
      statements: Number(row?.calls ?? 0),
      dataStatements: Number(row?.data ?? 0),
      dbMs: row?.exec ?? 0,
      rows: Number(row?.rows ?? 0),
    }
  }

  /** The statements of one call, as PostgreSQL normalised them, with how often each ran. */
  async function statementTexts(work: () => Promise<unknown>) {
    await db.$queryRawUnsafe('SELECT pg_stat_statements_reset()')
    await work()
    const rows = await db.$queryRawUnsafe<Array<{ calls: bigint; ms: number; query: string }>>(
      `SELECT calls, total_exec_time::float8 AS ms, query FROM pg_stat_statements
       WHERE query NOT ILIKE '%pg_stat_statements%' ORDER BY total_exec_time DESC`,
    )
    return rows.map((row) => ({
      calls: Number(row.calls),
      ms: round(row.ms),
      query: row.query.replace(/\s+/g, ' ').slice(0, 240),
    }))
  }

  /** One measured operation: its time, the statements it ran and the CPU of this process. */
  async function measure(work: () => Promise<number>): Promise<Sample> {
    await db.$queryRawUnsafe('SELECT pg_stat_statements_reset()')
    const cpu = process.cpuUsage()
    const started = performance.now()
    const calls = await work()
    const ms = performance.now() - started
    const used = process.cpuUsage(cpu)
    return { ms, calls, cpuMs: (used.user + used.system) / 1000, ...(await statements()) }
  }

  // --- What the page does -----------------------------------------------------------------------

  /**
   * Opening a chat as the page does it (apps/web use-dialog-feed.ts): the feed from its first row,
   * the next page at once while there is more. The last messages are on screen after the last page.
   */
  async function openChat(taskId: string): Promise<{ calls: number; cursor: string }> {
    let after = '0'
    let calls = 0
    for (;;) {
      const feed = await caller.task.feed({ taskId, after })
      calls += 1
      after = feed.cursor
      if (!feed.more) return { calls, cursor: after }
    }
  }

  /** A poll of an open chat with nothing new: what the page asks every 2 s while the agent works. */
  async function poll(taskId: string, after: string): Promise<number> {
    const feed = await caller.task.feed({ taskId, after })
    expect(feed.events).toHaveLength(0)
    return 1
  }

  /** The work of a running turn, read from its start (a reload while the agent works). */
  async function readActivity(
    taskId: string,
    turn: number,
  ): Promise<{ calls: number; cursor: string }> {
    let after = '0'
    let calls = 0
    for (;;) {
      const page = await caller.task.activity({ taskId, turn, after })
      calls += 1
      after = page.cursor
      if (!page.more) return { calls, cursor: after }
    }
  }

  // --- Synthetic chats --------------------------------------------------------------------------

  async function person(): Promise<User> {
    const row = await db.user.create({
      data: { name: 'Perf', email: `${randomUUID()}@perf.example.ru` },
    })
    await db.userConsent.createMany({
      data: legalDocuments.flatMap((document) =>
        document.required && document.consentType
          ? [
              {
                userId: row.id,
                documentType: document.consentType,
                documentVersion: document.version,
                granted: true,
                source: 'sign_up' as const,
              },
            ]
          : [],
      ),
    })
    return row
  }

  /**
   * A chat as its turns leave it: per turn the client's words, the step of the work, the journal
   * of the turn (lifecycle and output rows, hidden from the feed) and the answer. `running` — the
   * last turn is still writing its output.
   */
  async function addChat(input: {
    workspaceId: string
    turns: number
    running: boolean
  }): Promise<string> {
    const { workspaceId, turns, running } = input
    const task = await db.task.create({
      data: {
        workspaceId,
        createdById: owner.id,
        status: running ? 'running' : 'awaiting_user',
        title: 'Описание напитков в меню',
        turnNo: turns,
        needsBrowser: false,
      },
      select: { id: true },
    })
    let answer: bigint | null = null
    for (let turn = 1; turn <= turns; turn += 1) {
      const last = turn === turns
      const live = running && last
      const text = `${turn}. Поменяйте, пожалуйста, на странице «Меню» описание напитка номер ${turn}: добавьте объём и уберите слово «авторский».`
      const base = { v: 1, authorId: owner.id, requestId: randomUUID(), text } as const
      await visible(task.id, {
        type: 'feed.request',
        payload:
          answer === null
            ? { ...base, kind: 'first' }
            : { ...base, kind: 'answer', answersEventId: String(answer) },
      })
      const startedAt = new Date()
      const row = await db.taskTurn.create({
        data: {
          taskId: task.id,
          turnNo: turn,
          status: live ? 'running' : 'completed',
          driverId: 'opencode',
          image: `raditi/sbx@sha256:${'a'.repeat(64)}`,
          startedAt,
          ...(live ? {} : { finishedAt: startedAt }),
        },
        select: { id: true },
      })
      await visible(task.id, {
        type: 'feed.step',
        payload: { v: 1, turn, attempt: 1, step: 'work' },
      })
      await journal(task.id, row.id, turn, 'lifecycle', VOLUME.lifecyclePerTurn / 2)
      await journal(
        task.id,
        row.id,
        turn,
        'output',
        live ? VOLUME.runningOutput : VOLUME.outputPerTurn,
      )
      if (live) break
      await journal(task.id, row.id, turn, 'lifecycle', VOLUME.lifecyclePerTurn / 2)
      answer = await visible(task.id, {
        type: 'feed.result',
        payload: {
          v: 1,
          turn,
          message: `Ответ ${turn}. Посмотрел [страницу «Меню»](${SITE_URL}/menu/): напиток номер ${turn} описан в блоке «Кофе». Вот новое описание — напишите, если поправить.`,
          site: 'none',
          next: 'awaiting_user',
          filesChanged: null,
          changeType: 'none',
          needsApproval: false,
          risk: 'low',
        },
      })
    }
    return task.id
  }

  async function visible(taskId: string, row: unknown): Promise<bigint> {
    const parsed = feedRowSchema.parse(row)
    const created = await db.taskEvent.create({
      data: {
        taskId,
        type: parsed.type,
        payload: parsed.payload as Prisma.InputJsonValue,
        clientVisible: true,
      },
      select: { id: true },
    })
    return created.id
  }

  /**
   * Journal rows of a turn as core writes them: lifecycle entries of about 400 bytes, and output
   * batches — a draft of the text so far (growing, as the wrapper relays it), now and then a
   * command or a changed file.
   */
  async function journal(
    taskId: string,
    turnId: string,
    turn: number,
    kind: 'lifecycle' | 'output',
    count: number,
  ): Promise<void> {
    const fence = { siteId: taskId, taskId, operation: 'turn', epoch: 1 }
    if (kind === 'lifecycle') {
      await db.$executeRawUnsafe(
        `INSERT INTO task_events (task_id, turn_id, type, payload, client_visible)
         SELECT $1::uuid, $2::uuid, 'turn.lifecycle',
           jsonb_build_object('fence', $3::jsonb, 'sessionId', 'ses_' || md5($1 || $4::text),
             'turn', $4::int, 'sequence', g, 'phase', 'running', 'containerId', md5(g::text),
             'execId', md5((g + 1)::text), 'baseSha', repeat('a', 40)),
           false
         FROM generate_series(1, $5::int) g`,
        taskId,
        turnId,
        JSON.stringify(fence),
        turn,
        count,
      )
      return
    }
    await db.$executeRawUnsafe(
      `INSERT INTO task_events (task_id, turn_id, type, payload, client_visible)
       SELECT $1::uuid, $2::uuid, 'turn.output',
         jsonb_build_object('fence', $3::jsonb, 'sessionId', 'ses_' || md5($1 || $4::text),
           'turn', $4::int, 'sequence', g + 10, 'phase', 'output',
           'events', CASE WHEN g % 25 = 0
             THEN jsonb_build_array(jsonb_build_object('type', 'command', 'command', 'wp post list', 'exitCode', 0))
             ELSE jsonb_build_array(jsonb_build_object('type', 'draft', 'kind', 'text',
               'text', repeat('Смотрю шаблон страницы и описание напитка. ', least(g % 25 + 1, 60))))
           END),
         false
       FROM generate_series(1, $5::int) g`,
      taskId,
      turnId,
      JSON.stringify(fence),
      turn,
      count,
    )
  }

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    owner = await person()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId: owner.id, appEnv: 'test' }),
    )
    const place = { workspaceId: workspace.id }
    chats.short = await addChat({ ...place, turns: VOLUME.shortTurns, running: false })
    chats.long = await addChat({ ...place, turns: VOLUME.longTurns, running: false })
    for (let index = 0; index < VOLUME.runningChats; index += 1)
      chats.running.push(await addChat({ ...place, turns: VOLUME.runningDone + 1, running: true }))
    await db.$executeRawUnsafe('ANALYZE')
    const chat: ChatContext = {
      appEnv: 'test',
      browser: null,
      storage: () => ({ get: async () => null }) as unknown as ObjectStorage,
      secrets: () => ({}) as SecretStore,
    }
    caller = createCaller({
      prisma: db,
      headers: new Headers(),
      user: owner,
      session: {
        id: randomUUID(),
        userId: owner.id,
        token: `perf-${randomUUID()}`,
        expiresAt: new Date('2030-01-01'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
      billing: null,
      chat,
    })
    const [volume] = await db.$queryRawUnsafe<Array<{ rows: bigint; visible: bigint }>>(
      `SELECT count(*)::bigint AS rows, count(*) FILTER (WHERE client_visible)::bigint AS visible
       FROM task_events WHERE task_id = $1::uuid`,
      chats.long,
    )
    report.volume = {
      ...VOLUME,
      longChatRows: Number(volume?.rows ?? 0),
      longChatVisibleRows: Number(volume?.visible ?? 0),
    }
    // Warm the pool and the plans once: the first call of a process measures nothing of a chat.
    await openChat(chats.short)
  })

  afterAll(async () => {
    const scenarios = report.scenarios as Record<string, ReturnType<typeof summarize>> | undefined
    report.label = process.env.RADITI_PERF_LABEL ?? 'run'
    report.finishedAt = new Date().toISOString()
    report.summary = Object.fromEntries(
      Object.entries(scenarios ?? {}).map(([name, value]) => [
        name,
        `p50 ${value.ms.p50} ms, p95 ${value.ms.p95} ms, ${value.calls} calls, ${value.statements} statements (${value.dataStatements} data), db ${value.dbMs} ms, cpu ${value.cpuMs} ms`,
      ]),
    )
    if (process.env.RADITI_PERF_OUT)
      await writeFile(process.env.RADITI_PERF_OUT, `${JSON.stringify(report, null, 2)}\n`)
    await db?.$disconnect()
  })

  it('measures what the page asks of the database', async () => {
    const scenarios: Record<string, ReturnType<typeof summarize>> = {}
    report.scenarios = scenarios
    const repeat = async (times: number, work: () => Promise<number>) => {
      const samples: Sample[] = []
      for (let index = 0; index < times; index += 1) samples.push(await measure(work))
      return summarize(samples)
    }

    // Opening a chat: until its last messages are on screen.
    scenarios.openShort = await repeat(
      VOLUME.repeats.open,
      async () => (await openChat(chats.short)).calls,
    )
    scenarios.openLong = await repeat(
      VOLUME.repeats.open,
      async () => (await openChat(chats.long)).calls,
    )
    const running = chats.running[0]!
    scenarios.openRunning = await repeat(
      VOLUME.repeats.open,
      async () => (await openChat(running)).calls,
    )

    // An open chat where the agent works and nothing new came: the empty polls.
    const { cursor } = await openChat(running)
    scenarios.pollRunning = await repeat(VOLUME.repeats.poll, () => poll(running, cursor))
    const { cursor: longCursor } = await openChat(chats.long)
    scenarios.pollWaiting = await repeat(VOLUME.repeats.poll, () => poll(chats.long, longCursor))

    // The live work of the running turn: from its start (a reload), then the empty 1 s poll.
    const turn = VOLUME.runningDone + 1
    scenarios.activityReload = await repeat(
      VOLUME.repeats.activity,
      async () => (await readActivity(running, turn)).calls,
    )
    const { cursor: activityCursor } = await readActivity(running, turn)
    scenarios.activityPoll = await repeat(VOLUME.repeats.poll, async () => {
      const page = await caller.task.activity({ taskId: running, turn, after: activityCursor })
      expect(page.events).toHaveLength(0)
      return 1
    })

    // Several chats open at once, as tabs of one client or clients of one core: every 2 s each
    // polls its feed and, every second, the work of its turn (here both at once, per round).
    const cursors = await Promise.all(
      chats.running.map(async (taskId) => ({
        taskId,
        feed: (await openChat(taskId)).cursor,
        activity: (await readActivity(taskId, turn)).cursor,
      })),
    )
    const perPoll: number[] = []
    const rounds: Sample[] = []
    for (let index = 0; index < VOLUME.repeats.concurrentRounds; index += 1) {
      rounds.push(
        await measure(async () => {
          await Promise.all(
            cursors.flatMap(({ taskId, feed, activity }) => [
              (async () => {
                const started = performance.now()
                await poll(taskId, feed)
                perPoll.push(performance.now() - started)
              })(),
              caller.task.activity({ taskId, turn, after: activity }),
            ]),
          )
          return cursors.length * 2
        }),
      )
    }
    scenarios.concurrentRound = summarize(rounds)
    report.concurrentPoll = {
      n: perPoll.length,
      ms: { p50: round(percentile(perPoll, 50)), p95: round(percentile(perPoll, 95)) },
    }
    report.process = { rssMb: round(process.memoryUsage().rss / 1024 / 1024) }
    // What one call asked of the database, statement by statement.
    report.sql = {
      pollRunning: await statementTexts(() => poll(running, cursor)),
      pollWaiting: await statementTexts(() => poll(chats.long, longCursor)),
      openLong: await statementTexts(() => openChat(chats.long)),
    }
  })
})
