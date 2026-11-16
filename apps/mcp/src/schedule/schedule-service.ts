import type { ReservedScheduleChange, ScheduleChangeRequest } from '@repo/db'
import {
  canonicalTimezone,
  DEFAULT_SCHEDULE_TIMEZONE,
  isDomainError,
  runMomentText,
  scheduleErrorOfIssues,
  scheduleForbidden,
  scheduleText,
  type ScheduleTrigger,
} from '@repo/domain'
import type { z } from 'zod'

import type { McpTurnAccess } from '../access/mcp-access.ts'
import { MCP_UNATTENDED_REFUSAL } from '../access/mcp-policy.ts'
import {
  scheduleCreateArgumentsSchema,
  scheduleDeleteArgumentsSchema,
  scheduleListArgumentsSchema,
  scheduleUpdateArgumentsSchema,
} from './schedule-arguments.ts'

/**
 * The scheduled tasks for the agent (docs/plan/82-scheduled-tasks.md, Зп31–Зп34, Зп54): the tasks
 * of the chat's author, in the workspace of the chat — their personal one. Reading is at once; a
 * creation, a change and a deletion are reserved now, checked for everything that can be checked —
 * the rights, the 20 with the reservations open, the words, a place of a template left unfilled
 * (Зп59), a run ahead, five changes a turn — and applied by core when the turn ends (Зп33). Who the
 * caller is, its workspace, chat, turn come from the admitted turn, never from the arguments. In a
 * pass of a scheduled run without its client nothing is changed (Зп32): the role offers only
 * `schedule_list` there. A chat of a project lists and changes the tasks of its project, a chat
 * without one the tasks without one; a task the agent sets up or changes in a chat of a project
 * with a repository waits, off, for the client's «Включить задачу» (docs/plan/84-projects.md, ПР19).
 */

/** A task as the store lists it. */
export interface McpListedSchedule {
  id: string
  name: string
  instructions: string
  effort: string
  /** null — a row no writer would have written: shown, never guessed. */
  triggers: ScheduleTrigger[] | null
  timezone: string
  enabled: boolean
  notify: boolean
  pausedReason: string | null
  nextRunAt: Date | null
  lastRun: { dueAt: Date; trigger: string; status: string; reason: string | null } | null
}

/** A change this turn reserved and core has not applied yet. */
export interface McpPendingScheduleChange {
  reservedId: string
  kind: string
  scheduleId: string | null
  name: string | null
}

export interface McpScheduleStore {
  /**
   * The author of the chat, the zone of their browser and the project of the chat; null — the
   * chat has no author.
   */
  author(
    taskId: string,
  ): Promise<{ userId: string; timezone: string | null; projectId: string | null } | null>
  list(input: {
    userId: string
    workspaceId: string
    projectId: string | null
  }): Promise<McpListedSchedule[]>
  pending(taskId: string, turnNo: number): Promise<McpPendingScheduleChange[]>
  /** Throws a DomainError with the code and the words of its refusal. */
  reserve(input: {
    workspaceId: string
    taskId: string
    turnNo: number
    change: ScheduleChangeRequest
    now: Date
  }): Promise<ReservedScheduleChange>
}

/** What a tool answers: `ok` either way, the refusal with its code and its words (Зп33). */
export type McpScheduleAnswer =
  ({ ok: true } & Record<string, unknown>) | { ok: false; code: string; message: string }

const refusal = (error: unknown): McpScheduleAnswer => {
  if (isDomainError(error)) return { ok: false, code: error.code, message: error.message }
  throw error
}

const badRequest = (message: string): McpScheduleAnswer => ({
  ok: false,
  code: 'BAD_REQUEST',
  message,
})

/** The arguments as the domain takes them; runs closer than an hour — the client's words. */
function parsedOr<S extends z.ZodType>(
  schema: S,
  args: unknown,
  hint: string,
): { data: z.output<S> } | { refused: McpScheduleAnswer } {
  const parsed = schema.safeParse(args)
  if (parsed.success) return { data: parsed.data }
  const error = scheduleErrorOfIssues(parsed.error.issues)
  return { refused: error ? refusal(error) : badRequest(hint) }
}

const LIVE = 'when this turn ends'
const NEEDS_CLIENT =
  'It stays off: in a chat of a project with a repository only the client turns a task on, by the button «Включить задачу» under your answer. Tell the client so — never that it will run by itself.'
const NOT_YET =
  'Not saved yet: it goes live when this turn ends. Tell the client «Задача появится, как только я закончу ответ» — never that it is created, changed or deleted already.'

/** The wall clock of a zone for the agent: `2026-11-15 10:05, Sunday`. */
function wallClockOf(at: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'long',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}, ${parts.weekday}`
}

/** An answer of `schedule_list` the role sends whole: well under the 64 KiB of a tool's answer. */
export const SCHEDULE_LIST_MAX_BYTES = 56 * 1024
/** What is left of the instructions of a task when the list is too long for all of them. */
const CUT_INSTRUCTIONS = 400

type ListAnswer = { ok: true; schedules: Record<string, unknown>[] } & Record<string, unknown>

/**
 * The list within its bound: the instructions cut first — marked, so the agent never takes a piece
 * for the whole —, then the last tasks left out, and the answer says so.
 */
function bounded(answer: ListAnswer): McpScheduleAnswer {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
  if (size(answer) <= SCHEDULE_LIST_MAX_BYTES) return answer
  const schedules = answer.schedules.map((task) => {
    const text = typeof task.instructions === 'string' ? [...task.instructions] : []
    return text.length > CUT_INSTRUCTIONS
      ? {
          ...task,
          instructions: text.slice(0, CUT_INSTRUCTIONS).join(''),
          instructionsCut: true,
        }
      : task
  })
  const total = schedules.length
  while (schedules.length > 0 && size({ ...answer, schedules }) > SCHEDULE_LIST_MAX_BYTES)
    schedules.pop()
  return {
    ...answer,
    schedules,
    ...(schedules.length < total ? { truncated: true, total } : {}),
  }
}

/** The words of a stored task, or null for a zone this engine does not know: one task, not the list. */
function wordsOr(words: () => string): string | null {
  try {
    return words()
  } catch (error) {
    if (isDomainError(error)) return null
    throw error
  }
}

/** A zone this engine knows, as Intl names it; the default for one it does not. */
const zoneOf = (timezone: string | null): string =>
  (timezone === null ? null : canonicalTimezone(timezone)) ?? DEFAULT_SCHEDULE_TIMEZONE

export class McpScheduleService {
  readonly #store: McpScheduleStore
  readonly #now: () => Date

  constructor(deps: { store: McpScheduleStore; now?: () => Date }) {
    this.#store = deps.store
    this.#now = deps.now ?? (() => new Date())
  }

  /**
   * The author's tasks in the workspace of this chat — their personal one (Зп54) —, the changes
   * this turn reserved, the time now and the zone of the client (`users.timezone`, else Moscow).
   */
  async list(scope: McpTurnAccess, args: unknown = {}): Promise<McpScheduleAnswer> {
    if (!scheduleListArgumentsSchema.safeParse(args ?? {}).success)
      return badRequest('schedule_list takes no arguments')
    try {
      const author = await this.#store.author(scope.taskId)
      if (author === null) return refusal(scheduleForbidden())
      const now = this.#now()
      const timezone = zoneOf(author.timezone)
      const [schedules, pending] = await Promise.all([
        this.#store.list({
          userId: author.userId,
          workspaceId: scope.workspaceId,
          projectId: author.projectId,
        }),
        this.#store.pending(scope.taskId, scope.turn),
      ])
      return bounded({
        ok: true,
        now: now.toISOString(),
        timezone,
        clientTime: wallClockOf(now, timezone),
        schedules: schedules.map((task) => ({
          scheduleId: task.id,
          name: task.name,
          instructions: task.instructions,
          effort: task.effort,
          triggers: task.triggers,
          timezone: task.timezone,
          scheduleText:
            task.triggers === null
              ? null
              : wordsOr(() => scheduleText(task.triggers!, task.timezone)),
          state: task.enabled ? 'enabled' : (task.pausedReason ?? 'paused'),
          nextRunAt: task.nextRunAt?.toISOString() ?? null,
          nextRunText:
            task.nextRunAt === null
              ? null
              : wordsOr(() => runMomentText(task.nextRunAt!, task.timezone, now)),
          notify: task.notify,
          lastRun:
            task.lastRun === null
              ? null
              : {
                  at: task.lastRun.dueAt.toISOString(),
                  trigger: task.lastRun.trigger,
                  status: task.lastRun.status,
                  reason: task.lastRun.reason,
                },
        })),
        reservedThisTurn: pending,
      })
    } catch (error) {
      return refusal(error)
    }
  }

  /** A new task of the chat's author, once the client agreed to it (Зп34, Зп54). */
  async create(scope: McpTurnAccess, args: unknown): Promise<McpScheduleAnswer> {
    if (scope.unattended) return { ok: false, ...MCP_UNATTENDED_REFUSAL }
    const parsed = parsedOr(
      scheduleCreateArgumentsSchema,
      args,
      'Give name, instructions, triggers and confirmedByClient: true',
    )
    if ('refused' in parsed) return parsed.refused
    const { confirmedByClient: _confirmed, ...change } = parsed.data
    return this.#reserve(scope, { kind: 'create', ...change })
  }

  /** A change of a task of `schedule_list`, or of a change this turn reserved (Зп33). */
  async update(scope: McpTurnAccess, args: unknown): Promise<McpScheduleAnswer> {
    if (scope.unattended) return { ok: false, ...MCP_UNATTENDED_REFUSAL }
    const parsed = parsedOr(
      scheduleUpdateArgumentsSchema,
      args,
      'Give scheduleId or reservedId, one of the two, what changes and confirmedByClient: true',
    )
    if ('refused' in parsed) return parsed.refused
    const { confirmedByClient: _confirmed, ...change } = parsed.data
    return this.#reserve(scope, { kind: 'update', ...change })
  }

  /** A task goes when this turn ends; a change this turn reserved is cancelled at once. */
  async delete(scope: McpTurnAccess, args: unknown): Promise<McpScheduleAnswer> {
    if (scope.unattended) return { ok: false, ...MCP_UNATTENDED_REFUSAL }
    const parsed = parsedOr(
      scheduleDeleteArgumentsSchema,
      args,
      'Give scheduleId or reservedId, one of the two, and confirmedByClient: true',
    )
    if ('refused' in parsed) return parsed.refused
    const { confirmedByClient: _confirmed, ...change } = parsed.data
    return this.#reserve(scope, { kind: 'delete', ...change })
  }

  async #reserve(scope: McpTurnAccess, change: ScheduleChangeRequest): Promise<McpScheduleAnswer> {
    const now = this.#now()
    try {
      const reserved = await this.#store.reserve({
        workspaceId: scope.workspaceId,
        taskId: scope.taskId,
        turnNo: scope.turn,
        change,
        now,
      })
      return answerOf(reserved, now)
    } catch (error) {
      return refusal(error)
    }
  }
}

/** The answer of a reservation (Зп33): what the task will be, and when it goes live. */
function answerOf(reserved: ReservedScheduleChange, now: Date): McpScheduleAnswer {
  if (reserved.cancelled)
    return {
      ok: true,
      reservedId: reserved.reservationId,
      cancelled: true,
      warnings: ['The change this turn reserved is cancelled: nothing of it will be saved.'],
    }
  const { fields } = reserved
  if (fields === null)
    return {
      ok: true,
      reservedId: reserved.reservationId,
      action: reserved.kind,
      scheduleId: reserved.scheduleId,
      live: LIVE,
      warnings: [NOT_YET],
    }
  return {
    ok: true,
    reservedId: reserved.reservationId,
    action: reserved.kind,
    scheduleId: reserved.scheduleId,
    name: fields.name,
    scheduleText: scheduleText(fields.triggers, fields.timezone),
    timezone: fields.timezone,
    enabled: fields.enabled,
    nextRunAt: reserved.nextRunAt?.toISOString() ?? null,
    nextRunText:
      reserved.nextRunAt === null ? null : runMomentText(reserved.nextRunAt, fields.timezone, now),
    live: LIVE,
    ...(reserved.needsClient ? { needsClient: true } : {}),
    warnings: reserved.needsClient ? [NOT_YET, NEEDS_CLIENT] : [NOT_YET],
  }
}
