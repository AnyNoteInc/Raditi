// Scheduled tasks in the database (docs/plan/82-scheduled-tasks.md, §4.2): the value lists of the
// CHECKs are the arrays of @repo/domain, the shapes of a task, a run, a reservation and a notice
// hold, and a notice written before the migration stays as it was. Runs the real migrations in a
// disposable schema.
import { randomUUID } from 'node:crypto'

import {
  notificationKinds,
  reasoningEfforts,
  scheduleCreatedVia,
  scheduledRunReasons,
  scheduledRunStatuses,
  scheduledRunTriggers,
  scheduleLeftActions,
  schedulePausedReasons,
} from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { scheduleReservationOutcomes } from '../src/scheduled-tasks.ts'
import { uuidv7 } from '../src/uuidv7.ts'
import { createMigratedSchema, type MigratedSchema } from './migrated-schema.ts'

const databaseUrl = process.env.DATABASE_URL
/** The last migration before the scheduled tasks (Зп63). */
const before = '20261116200000_llm_model_context_tokens'
const at = new Date('2026-11-16T09:00:00Z')
type Values = Record<string, unknown>

describe.skipIf(!databaseUrl)('the migration of scheduled tasks', () => {
  let schema: MigratedSchema
  const workspaceId = randomUUID()
  const userId = randomUUID()
  // A chat: its id is a UUID of version 7 (tasks_chat_id_check).
  const taskId = uuidv7()
  const earlierNotice = randomUUID()
  // A client who had turned push off under the old switch, and one who had it on (Зп37).
  const silentId = randomUUID()
  const loudId = randomUUID()

  async function insert(table: string, values: Values) {
    const columns = Object.keys(values)
    await schema.db.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(values).map((value) =>
        value !== null && typeof value === 'object' && !(value instanceof Date)
          ? JSON.stringify(value)
          : value,
      ),
    )
  }

  /** The constraint a write broke; undefined — it was accepted. Each write in its savepoint. */
  async function refusal(write: () => Promise<unknown>): Promise<string | undefined> {
    await schema.db.query('SAVEPOINT attempt')
    try {
      await write()
      await schema.db.query('RELEASE SAVEPOINT attempt')
      return undefined
    } catch (error) {
      await schema.db.query('ROLLBACK TO SAVEPOINT attempt')
      return (error as { constraint?: string }).constraint ?? String(error)
    }
  }

  /** The quoted values a CHECK lists, in order. */
  async function listed(table: string, constraint: string): Promise<string[]> {
    const { rows } = await schema.db.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
       WHERE c.conname = $1 AND c.conrelid = $2::regclass`,
      [constraint, table],
    )
    const definition = rows[0]?.definition ?? ''
    return [...definition.matchAll(/'([a-z_]+)'::(?:character varying|text)/g)].map(
      (match) => match[1] ?? '',
    )
  }

  const task = (extra: Values = {}): Values => ({
    id: uuidv7(),
    workspace_id: workspaceId,
    created_by_id: userId,
    name: 'Курс валют',
    instructions: 'Пришли курс доллара по ЦБ на сегодня',
    effort: 'low',
    triggers: [{ kind: 'weekdays', time: '09:00' }],
    timezone: 'Europe/Moscow',
    next_run_at: new Date('2026-11-17T06:00:00Z'),
    created_via: 'manual',
    updated_at: at,
    ...extra,
  })

  const run = (scheduledTaskId: string, extra: Values = {}): Values => ({
    id: uuidv7(),
    scheduled_task_id: scheduledTaskId,
    due_at: at,
    trigger: 'schedule',
    status: 'pending',
    name: 'Курс валют',
    instructions: 'Пришли курс доллара по ЦБ на сегодня',
    effort: 'low',
    ...extra,
  })

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'scheduled_tasks')
    await schema.migrate(before)
    await insert('users', {
      id: userId,
      name: 'Анна',
      email: `${userId}@example.test`,
      updated_at: at,
    })
    await insert('workspaces', {
      id: workspaceId,
      name: 'Synthetic workspace',
      data_class: 'synthetic',
      updated_at: at,
    })
    await insert('tasks', {
      id: taskId,
      workspace_id: workspaceId,
      needs_browser: false,
      updated_at: at,
    })
    // A notice of a chat as plan 75 wrote it: no pass, no task of a schedule.
    await insert('chat_notifications', {
      id: earlierNotice,
      task_id: taskId,
      user_id: userId,
      kind: 'answered',
    })
    for (const [id, push] of [
      [silentId, false],
      [loudId, true],
    ] as const) {
      await insert('users', { id, name: 'Клиент', email: `${id}@example.test`, updated_at: at })
      await insert('notification_settings', { user_id: id, push, updated_at: at })
      for (const browser of ['laptop', 'phone'])
        await insert('push_subscriptions', {
          id: randomUUID(),
          user_id: id,
          endpoint: `https://fcm.googleapis.com/fcm/send/${id}-${browser}`,
          p256dh: 'key',
          auth: 'auth',
        })
    }
    await schema.migrate()
    await schema.db.query('BEGIN')
  }, 120_000)
  afterAll(async () => {
    await schema?.drop()
  })

  it('names no site in a task or a run (Зп44, Зп63)', async () => {
    const { rows } = await schema.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND column_name = 'site_id'
         AND table_name IN ('scheduled_tasks', 'scheduled_runs')`,
    )
    expect(rows).toEqual([])
  })

  it('binds a task and a run to a project, which a purge leaves them without (ПР19)', async () => {
    const { rows } = await schema.db.query<{ table_name: string; delete_rule: string }>(
      `SELECT c.table_name, r.delete_rule
       FROM information_schema.referential_constraints r
       JOIN information_schema.table_constraints c
         ON c.constraint_name = r.constraint_name AND c.constraint_schema = r.constraint_schema
       WHERE r.constraint_schema = current_schema()
         AND r.constraint_name IN ('scheduled_tasks_project_id_fkey', 'scheduled_runs_project_id_fkey')
       ORDER BY c.table_name`,
    )
    expect(rows).toEqual([
      { table_name: 'scheduled_runs', delete_rule: 'SET NULL' },
      { table_name: 'scheduled_tasks', delete_rule: 'SET NULL' },
    ])
  })

  it('lists in its CHECKs exactly the values of the domain', async () => {
    expect(await listed('scheduled_tasks', 'scheduled_tasks_effort_check')).toEqual([
      ...reasoningEfforts,
    ])
    expect(await listed('scheduled_tasks', 'scheduled_tasks_paused_reason_check')).toEqual([
      ...schedulePausedReasons,
    ])
    expect(await listed('scheduled_tasks', 'scheduled_tasks_last_refusal_reason_check')).toEqual([
      ...scheduledRunReasons,
    ])
    expect(
      (await listed('scheduled_tasks', 'scheduled_tasks_created_via_check')).slice(
        0,
        scheduleCreatedVia.length,
      ),
    ).toEqual([...scheduleCreatedVia])
    expect(await listed('scheduled_runs', 'scheduled_runs_trigger_check')).toEqual([
      ...scheduledRunTriggers,
    ])
    expect(await listed('scheduled_runs', 'scheduled_runs_status_check')).toEqual([
      ...scheduledRunStatuses,
    ])
    expect(await listed('scheduled_runs', 'scheduled_runs_reason_check')).toEqual([
      ...scheduledRunReasons,
    ])
    expect(await listed('scheduled_runs', 'scheduled_runs_effort_check')).toEqual([
      ...reasoningEfforts,
    ])
    expect(await listed('schedule_reservations', 'schedule_reservations_kind_check')).toEqual([
      ...scheduleLeftActions,
    ])
    expect(await listed('schedule_reservations', 'schedule_reservations_outcome_check')).toEqual([
      ...scheduleReservationOutcomes,
    ])
    expect(await listed('chat_notifications', 'chat_notifications_kind_check')).toEqual([
      ...notificationKinds,
    ])
  })

  it('keeps a notice written before it and takes the new kinds', async () => {
    const { rows } = await schema.db.query<{ kind: string; attempt: number | null }>(
      'SELECT kind, attempt FROM chat_notifications WHERE id = $1',
      [earlierNotice],
    )
    expect(rows).toEqual([{ kind: 'answered', attempt: null }])
    // The rows before it have no pass: a second one of the same kind is no duplicate.
    expect(
      await refusal(() =>
        insert('chat_notifications', {
          id: randomUUID(),
          task_id: taskId,
          user_id: userId,
          kind: 'answered',
        }),
      ),
    ).toBeUndefined()
  })

  it('holds a task off without a due moment, stopped only when off, off when deleted', async () => {
    expect(await refusal(() => insert('scheduled_tasks', task()))).toBeUndefined()
    // «Только вручную»: on, with no due moment.
    expect(
      await refusal(() => insert('scheduled_tasks', task({ triggers: [], next_run_at: null }))),
    ).toBeUndefined()
    expect(await refusal(() => insert('scheduled_tasks', task({ enabled: false })))).toBe(
      'scheduled_tasks_next_run_check',
    )
    expect(
      await refusal(() => insert('scheduled_tasks', task({ paused_reason: 'completed' }))),
    ).toBe('scheduled_tasks_paused_check')
    expect(
      await refusal(() =>
        insert(
          'scheduled_tasks',
          task({ enabled: false, next_run_at: null, paused_reason: 'done' }),
        ),
      ),
    ).toBe('scheduled_tasks_paused_reason_check')
    expect(await refusal(() => insert('scheduled_tasks', task({ deleted_at: at })))).toBe(
      'scheduled_tasks_deleted_check',
    )
    expect(
      await refusal(() =>
        insert('scheduled_tasks', task({ created_via: 'manual', template_slug: 'currency-rates' })),
      ),
    ).toBe('scheduled_tasks_created_via_check')
    expect(
      await refusal(() =>
        insert('scheduled_tasks', task({ created_via: 'manual', source_task_id: taskId })),
      ),
    ).toBe('scheduled_tasks_created_via_check')
    expect(await refusal(() => insert('scheduled_tasks', task({ effort: 'medium' })))).toBe(
      'scheduled_tasks_effort_check',
    )
    expect(
      await refusal(() =>
        insert(
          'scheduled_tasks',
          task({ triggers: Array.from({ length: 6 }, () => ({ kind: 'daily', time: '09:00' })) }),
        ),
      ),
    ).toBe('scheduled_tasks_triggers_check')
    expect(await refusal(() => insert('scheduled_tasks', task({ timezone: '+03:00' })))).toBe(
      'scheduled_tasks_timezone_check',
    )
    expect(await refusal(() => insert('scheduled_tasks', task({ name: '' })))).toBe(
      'scheduled_tasks_name_check',
    )
  })

  it('holds a run with a chat exactly when started and a reason exactly when not', async () => {
    const parent = task()
    await insert('scheduled_tasks', parent)
    const id = parent.id as string
    expect(await refusal(() => insert('scheduled_runs', run(id)))).toBeUndefined()
    expect(
      await refusal(() =>
        insert(
          'scheduled_runs',
          run(id, { due_at: new Date('2026-11-16T10:00:00Z'), status: 'started' }),
        ),
      ),
    ).toBe('scheduled_runs_task_check')
    expect(
      await refusal(() =>
        insert(
          'scheduled_runs',
          run(id, { due_at: new Date('2026-11-16T11:00:00Z'), status: 'refused' }),
        ),
      ),
    ).toBe('scheduled_runs_outcome_check')
    expect(
      await refusal(() =>
        insert(
          'scheduled_runs',
          run(id, { due_at: new Date('2026-11-16T12:00:00Z'), reason: 'platform' }),
        ),
      ),
    ).toBe('scheduled_runs_outcome_check')
    // Missed moments without a reason: NULL is no pass.
    expect(
      await refusal(() =>
        insert(
          'scheduled_runs',
          run(id, { due_at: new Date('2026-11-16T12:30:00Z'), missed_count: 2 }),
        ),
      ),
    ).toBe('scheduled_runs_missed_count_check')
    expect(
      await refusal(() =>
        insert(
          'scheduled_runs',
          run(id, {
            due_at: new Date('2026-11-16T13:00:00Z'),
            status: 'skipped',
            reason: 'previous_running',
            missed_count: 2,
          }),
        ),
      ),
    ).toBe('scheduled_runs_missed_count_check')
    expect(
      await refusal(() =>
        insert(
          'scheduled_runs',
          run(id, {
            due_at: new Date('2026-11-16T14:00:00Z'),
            status: 'skipped',
            reason: 'missed',
            missed_count: 3,
            missed_until: new Date('2026-11-16T14:20:00Z'),
          }),
        ),
      ),
    ).toBeUndefined()
    // The end of a gap: only on a row of missed runs, and not before its first moment.
    expect(
      await refusal(() =>
        insert(
          'scheduled_runs',
          run(id, {
            due_at: new Date('2026-11-16T14:30:00Z'),
            status: 'skipped',
            reason: 'previous_running',
            missed_until: new Date('2026-11-16T14:30:00Z'),
          }),
        ),
      ),
    ).toBe('scheduled_runs_missed_until_check')
    expect(
      await refusal(() =>
        insert(
          'scheduled_runs',
          run(id, {
            due_at: new Date('2026-11-16T14:40:00Z'),
            status: 'skipped',
            reason: 'missed',
            missed_count: 2,
            missed_until: new Date('2026-11-16T14:39:00Z'),
          }),
        ),
      ),
    ).toBe('scheduled_runs_missed_until_check')
    // One row per moment and kind: a second claim writes nothing.
    expect(await refusal(() => insert('scheduled_runs', run(id)))).toBe(
      'scheduled_runs_scheduled_task_id_due_at_trigger_key',
    )
    expect(
      await refusal(() => insert('scheduled_runs', run(id, { trigger: 'manual' }))),
    ).toBeUndefined()
    expect(
      await refusal(() =>
        insert(
          'scheduled_runs',
          run(id, { due_at: new Date('2026-11-16T15:00:00Z'), trigger: 'cron' }),
        ),
      ),
    ).toBe('scheduled_runs_trigger_check')
  })

  it('holds a reservation of a change: a task of an update, a closed one with its moment', async () => {
    const parent = task()
    await insert('scheduled_tasks', parent)
    const reservation = (extra: Values = {}): Values => ({
      id: uuidv7(),
      workspace_id: workspaceId,
      task_id: taskId,
      turn_no: 1,
      kind: 'create',
      payload: { name: 'Новое' },
      ...extra,
    })
    expect(await refusal(() => insert('schedule_reservations', reservation()))).toBeUndefined()
    expect(
      await refusal(() => insert('schedule_reservations', reservation({ kind: 'update' }))),
    ).toBe('schedule_reservations_schedule_check')
    expect(
      await refusal(() => insert('schedule_reservations', reservation({ schedule_id: parent.id }))),
    ).toBe('schedule_reservations_schedule_check')
    expect(
      await refusal(() =>
        insert(
          'schedule_reservations',
          reservation({ schedule_id: parent.id, outcome: 'done', closed_at: at }),
        ),
      ),
    ).toBeUndefined()
    expect(
      await refusal(() => insert('schedule_reservations', reservation({ outcome: 'refused' }))),
    ).toBe('schedule_reservations_outcome_check')
    expect(
      await refusal(() => insert('schedule_reservations', reservation({ payload: [1] }))),
    ).toBe('schedule_reservations_payload_check')
    expect(await refusal(() => insert('schedule_reservations', reservation({ turn_no: 0 })))).toBe(
      'schedule_reservations_turn_no_check',
    )
  })

  it('holds a notice of a chat or of a task, one of a kind per pass and per run', async () => {
    const parent = task()
    await insert('scheduled_tasks', parent)
    const parentRun = run(parent.id as string, { due_at: new Date('2026-11-18T06:00:00Z') })
    await insert('scheduled_runs', parentRun)
    const notice = (extra: Values): Values => ({ id: randomUUID(), user_id: userId, ...extra })
    // A run that did not start: no chat, the task and its run.
    const notStarted = notice({
      kind: 'not_started',
      scheduled_task_id: parent.id,
      scheduled_run_id: parentRun.id,
    })
    expect(await refusal(() => insert('chat_notifications', notStarted))).toBeUndefined()
    expect(
      await refusal(() => insert('chat_notifications', { ...notStarted, id: randomUUID() })),
    ).toBe('chat_notifications_run_key')
    // A pass of a chat needs the chat.
    expect(
      await refusal(() =>
        insert('chat_notifications', notice({ kind: 'answered', scheduled_task_id: parent.id })),
      ),
    ).toBe('chat_notifications_target_check')
    expect(await refusal(() => insert('chat_notifications', notice({ kind: 'paused' })))).toBe(
      'chat_notifications_target_check',
    )
    expect(
      await refusal(() =>
        insert(
          'chat_notifications',
          notice({ task_id: taskId, kind: 'answered', scheduled_run_id: parentRun.id }),
        ),
      ),
    ).toBe('chat_notifications_run_check')
    expect(
      await refusal(() =>
        insert('chat_notifications', notice({ task_id: taskId, kind: 'ready', attempt: 1 })),
      ),
    ).toBe('chat_notifications_pass_check')
    const pass = notice({ task_id: taskId, kind: 'ready', attempt: 1, turn_no: 2 })
    expect(await refusal(() => insert('chat_notifications', pass))).toBeUndefined()
    expect(await refusal(() => insert('chat_notifications', { ...pass, id: randomUUID() }))).toBe(
      'chat_notifications_pass_key',
    )
    expect(
      await refusal(() => insert('chat_notifications', { ...pass, id: randomUUID(), turn_no: 3 })),
    ).toBeUndefined()
    expect(
      await refusal(() => insert('chat_notifications', notice({ task_id: taskId, kind: 'gone' }))),
    ).toBe('chat_notifications_kind_check')
  })

  it('gives up the browsers of a client who had turned push off, and keeps the others (Зп37)', async () => {
    const { rows } = await schema.db.query<{ user_id: string; count: string }>(
      `SELECT user_id, count(*) FROM push_subscriptions WHERE user_id = ANY($1::uuid[])
       GROUP BY user_id`,
      [[silentId, loudId]],
    )
    expect(rows.map((row) => [row.user_id, Number(row.count)])).toEqual([[loudId, 2]])
  })

  it('takes a zone of the client and the key of a browser', async () => {
    expect(
      await refusal(() =>
        schema.db.query('UPDATE users SET timezone = $1 WHERE id = $2', [
          'Asia/Novosibirsk',
          userId,
        ]),
      ),
    ).toBeUndefined()
    expect(
      await refusal(() =>
        schema.db.query('UPDATE users SET timezone = $1 WHERE id = $2', ['+03:00', userId]),
      ),
    ).toBe('users_timezone_check')
    expect(
      await refusal(() =>
        insert('push_subscriptions', {
          id: randomUUID(),
          user_id: userId,
          endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
          p256dh: 'key',
          auth: 'auth',
          vapid_key: 'B'.repeat(87),
        }),
      ),
    ).toBeUndefined()
  })
})
