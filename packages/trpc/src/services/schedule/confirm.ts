import { createHash, randomBytes } from 'node:crypto'

import { confirmScheduledTask, readScheduledTask, type PrismaClient } from '@repo/db'
import { gitConnectUnavailable, scheduleConfirmChanged, type RepoConfirmMac } from '@repo/domain'

import { readSchedule, type ScheduleDetail } from './manage.ts'

// «Включить задачу» (docs/plan/84-projects.md, ПР19): a task the agent set up or changed in a chat
// of a project with a repository waits, off, for its creator. The card of the chat shows the task as
// it is and holds a token — the HMAC by REPO_CONFIRM_SECRET over the creator, the task and the
// fingerprint of its words, its schedule and its last change —; «Включить задачу» turns the task on
// only while it still is exactly that, under its row. A change of the agent since moves `updated_at`
// and the words: the card of before no longer turns anything on. `confirmedByClient` of the tools is
// the model's word, never this.

/** How long a card's token holds; the card asks for a new one before (its query refetches). */
export const SCHEDULE_CONFIRM_TTL_SECONDS = 60 * 60

const TOKEN = /^([0-9a-f-]{36})\.(\d{1,12})\.([0-9a-f]{32})\.([A-Za-z0-9_-]{16,128})$/

/** The words, the schedule and the moment of the last change of a task, hashed. */
export function scheduleFingerprint(task: {
  name: string
  instructions: string
  triggers: unknown
  timezone: string
  effort: string
  updatedAt: Date
}): string {
  return createHash('sha256')
    .update(
      [
        task.name,
        task.instructions,
        JSON.stringify(task.triggers),
        task.timezone,
        task.effort,
        task.updatedAt.toISOString(),
      ].join('\n'),
    )
    .digest('hex')
}

const material = (input: {
  userId: string
  scheduleId: string
  fingerprint: string
  nonce: string
  expiresAt: number
}) =>
  [
    'raditi-schedule-confirm:v1',
    input.userId,
    input.scheduleId,
    input.fingerprint,
    input.nonce,
    input.expiresAt,
  ].join('\n')

/** The same strings in constant time. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const macOf = (mac: RepoConfirmMac | null | undefined): RepoConfirmMac => {
  if (!mac) throw gitConnectUnavailable()
  return mac
}

/** What the card shows and the token of exactly that. */
export interface ScheduleConfirmCard {
  schedule: ScheduleDetail
  confirmToken: string
}

/**
 * The card «Включить задачу»: the task of the creator that waits for them, and a token of it as it
 * is now. SCHEDULE_CONFIRM_CHANGED for a task that waits no more — turned on, off by the client,
 * deleted.
 */
export async function prepareScheduleConfirm(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: { userId: string; scheduleId: string; now: Date },
): Promise<ScheduleConfirmCard> {
  const sign = macOf(mac)
  const row = await readScheduledTask(db, input)
  if (row.pausedReason !== 'unconfirmed') throw scheduleConfirmChanged()
  const nonce = randomBytes(16).toString('hex')
  const expiresAt = Math.floor(input.now.getTime() / 1000) + SCHEDULE_CONFIRM_TTL_SECONDS
  const fingerprint = scheduleFingerprint(row)
  const signature = sign(
    material({ userId: input.userId, scheduleId: row.id, fingerprint, nonce, expiresAt }),
  )
  const schedule = await readSchedule(db, input)
  return {
    schedule,
    confirmToken: `${row.id}.${expiresAt}.${nonce}.${signature}`,
  }
}

/**
 * «Включить задачу»: the token is the platform's, of this user and this task, not expired, and the
 * task under its row is still the one it was made of. SCHEDULE_CONFIRM_CHANGED for anything else —
 * a forged token is told no differently from a stale one.
 */
export async function confirmSchedule(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: { userId: string; confirmToken: string; now: Date },
): Promise<ScheduleDetail> {
  const sign = macOf(mac)
  const found = TOKEN.exec(input.confirmToken)
  if (!found) throw scheduleConfirmChanged()
  const [, scheduleId, expires, nonce, signature] = found as unknown as [
    string,
    string,
    string,
    string,
    string,
  ]
  const expiresAt = Number(expires)
  if (expiresAt * 1000 <= input.now.getTime()) throw scheduleConfirmChanged()
  await confirmScheduledTask(db, {
    scheduleId,
    userId: input.userId,
    now: input.now,
    signed: (task) =>
      same(
        sign(
          material({
            userId: input.userId,
            scheduleId: task.id,
            fingerprint: scheduleFingerprint(task),
            nonce,
            expiresAt,
          }),
        ),
        signature,
      ),
  })
  return readSchedule(db, { userId: input.userId, scheduleId })
}
