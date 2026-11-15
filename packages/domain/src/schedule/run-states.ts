import { z } from 'zod'

import { scheduledRunReasons, scheduledRunReasonText } from './runs.ts'

/**
 * What came of a run of a scheduled task, as its row in the list and on the page of the task say
 * it (docs/plan/82-scheduled-tasks.md, Зп5, Зп6): a run that started is told by the state of its
 * chat — by the same rules as the list of chats —, one that did not by its reason.
 */

/** What stopped the chat of a run at its limit: credits, or the weekly limit of the workspace. */
export const scheduledRunStopCauses = ['credits', 'weekly_limit'] as const
export type ScheduledRunStopCause = (typeof scheduledRunStopCauses)[number]

export const scheduledRunStateKinds = [
  'pending',
  'running',
  'done',
  'waiting',
  'ready',
  'failed',
  'stopped',
  'chat_deleted',
  'refused',
  'skipped',
] as const
export type ScheduledRunStateKind = (typeof scheduledRunStateKinds)[number]

const reason = z.enum(scheduledRunReasons)

export const scheduledRunStateSchema = z.discriminatedUnion('kind', [
  /** core handed the run to web, which has not answered yet. */
  z.strictObject({ kind: z.literal('pending') }),
  /** Its chat works: queued, preparing or running. */
  z.strictObject({ kind: z.literal('running') }),
  /** The agent answered and asked nothing, or the chat is done. */
  z.strictObject({ kind: z.literal('done') }),
  /** The agent asked a question: the chat waits for the client's answer. */
  z.strictObject({ kind: z.literal('waiting') }),
  /** A candidate waits for the client's look and `/release`. */
  z.strictObject({ kind: z.literal('ready') }),
  /** The last pass failed, or the chat ended without an answer. */
  z.strictObject({ kind: z.literal('failed') }),
  /** The chat stopped at its limit; null — at a limit of another kind. */
  z.strictObject({ kind: z.literal('stopped'), cause: z.enum(scheduledRunStopCauses).nullable() }),
  /** The chat of the run was deleted: nothing more is told of it. */
  z.strictObject({ kind: z.literal('chat_deleted') }),
  z.strictObject({ kind: z.literal('refused'), reason }),
  /**
   * «Пропущено»; `missedCount` — how many moments one row of «missed» stands for, `missedUntil` —
   * the latest of them, as the tick wrote it («Пропущены запуски с … по …»); null — a row of
   * another reason, or one written without it.
   */
  z.strictObject({
    kind: z.literal('skipped'),
    reason,
    missedCount: z.number().int().min(0),
    missedUntil: z.date().nullable(),
  }),
])
export type ScheduledRunState = z.infer<typeof scheduledRunStateSchema>

const stopText: Readonly<Record<ScheduledRunStopCause, string>> = Object.freeze({
  credits: 'Остановилась: закончились кредиты',
  weekly_limit: 'Остановилась: исчерпан недельный лимит',
})

/** The words of a run's state (Зп5): «Выполнена», «Не запустилась: нужен тариф», «Пропущено». */
export function scheduledRunStateText(state: ScheduledRunState): string {
  switch (state.kind) {
    case 'pending':
    case 'running':
      return 'Выполняется'
    case 'done':
      return 'Выполнена'
    case 'waiting':
      return 'Ждёт вашего ответа'
    case 'ready':
      return 'Изменения готовы'
    case 'failed':
      return 'Не выполнена'
    case 'stopped':
      return state.cause === null ? 'Остановилась' : stopText[state.cause]
    case 'chat_deleted':
      return 'Чат удалён'
    case 'refused':
      return `Не запустилась: ${scheduledRunReasonText[state.reason]}`
    case 'skipped':
      return state.reason === 'missed'
        ? 'Пропущено'
        : `Пропущено: ${scheduledRunReasonText[state.reason]}`
  }
}
