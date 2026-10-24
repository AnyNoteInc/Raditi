import {
  browserCheckpointRefSchema,
  browserCheckpointStates,
  browserVerifiedObjectSchema,
  conflict,
  type BrowserCheckpointRef,
  type BrowserCheckpointState,
  type BrowserVerifiedObject,
} from '@repo/domain'
import { z } from 'zod'

import type { Prisma } from './generated/prisma/client.ts'
import { uuidv7 } from './uuidv7.ts'

// What a task made on the site through its browser (docs/plan/57-browser-tasks.md, Б22–Б24): the
// worker records a checkpoint when a page shows the editor of an object, marks it `unverified`
// after a save or publish click and records what a trusted read found; core reads them all at
// the end of a pass and on «Остановить».

export interface BrowserCheckpointRecord {
  id: string
  taskId: string
  /** The session that last saw the object. */
  sessionId: string
  ref: BrowserCheckpointRef
  state: BrowserCheckpointState
  /** What the last trusted read found; null unless `verified`. */
  verified: BrowserVerifiedObject | null
  createdAt: Date
  updatedAt: Date
}

const upsertSchema = z
  .strictObject({
    taskId: z.uuid(),
    sessionId: z.uuid(),
    ref: browserCheckpointRefSchema,
    state: z.enum(browserCheckpointStates),
    verified: browserVerifiedObjectSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if ((input.state === 'verified') !== (input.verified !== undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['verified'],
        message: 'what a read found comes exactly with `verified`',
      })
    if (
      input.verified &&
      (input.verified.kind !== input.ref.kind || input.verified.objectId !== input.ref.objectId)
    )
      ctx.addIssue({ code: 'custom', path: ['verified'], message: 'a read of another object' })
  })

interface CheckpointRow {
  id: string
  task_id: string
  session_id: string
  kind: string
  object_id: string
  edit_url: string
  state: BrowserCheckpointState
  verified: unknown
  created_at: Date
  updated_at: Date
}

/**
 * Records a checkpoint of the task, seen in one of its sessions. `seen` only adds an object the
 * task had not met: opening an editor again unsaves nothing, so the state and what a read found
 * stay. Any other state replaces them — a save after a confirmation is unverified again.
 */
export async function upsertBrowserCheckpoint(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: {
    taskId: string
    sessionId: string
    ref: BrowserCheckpointRef
    state: BrowserCheckpointState
    verified?: BrowserVerifiedObject
  },
): Promise<BrowserCheckpointRecord> {
  const { taskId, sessionId, ref, state, verified } = upsertSchema.parse(input)
  const [row] = await db.$queryRaw<CheckpointRow[]>`
    INSERT INTO browser_checkpoints
      (id, task_id, session_id, kind, object_id, edit_url, state, verified, updated_at)
    SELECT ${uuidv7()}::uuid, b.task_id, b.id, ${ref.kind}, ${ref.objectId}, ${ref.editUrl},
           ${state}::"BrowserCheckpointState",
           ${verified ? JSON.stringify(verified) : null}::jsonb, clock_timestamp()
      FROM browser_sessions b
     WHERE b.id = ${sessionId}::uuid AND b.task_id = ${taskId}::uuid
    ON CONFLICT (task_id, kind, object_id) DO UPDATE SET
      session_id = EXCLUDED.session_id,
      edit_url = EXCLUDED.edit_url,
      state = CASE WHEN EXCLUDED.state = 'seen' THEN browser_checkpoints.state
                   ELSE EXCLUDED.state END,
      verified = CASE WHEN EXCLUDED.state = 'seen' THEN browser_checkpoints.verified
                      ELSE EXCLUDED.verified END,
      updated_at = EXCLUDED.updated_at
    RETURNING id, task_id, session_id, kind, object_id, edit_url, state, verified, created_at,
              updated_at`
  if (!row) throw conflict('The browser session is not one of the task')
  const record = checkpointOf(row)
  if (!record) throw conflict('The browser checkpoint cannot be read back')
  return record
}

/**
 * Every checkpoint of the task, oldest first. A row this code cannot read — a kind it does not
 * know — is history and left out; what a read found that no longer parses is unconfirmed.
 */
export async function taskBrowserCheckpoints(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  taskId: string,
): Promise<BrowserCheckpointRecord[]> {
  const rows = await db.$queryRaw<CheckpointRow[]>`
    SELECT id, task_id, session_id, kind, object_id, edit_url, state, verified, created_at,
           updated_at
      FROM browser_checkpoints
     WHERE task_id = ${z.uuid().parse(taskId)}::uuid
     ORDER BY created_at, id`
  return rows.flatMap((row) => checkpointOf(row) ?? [])
}

function checkpointOf(row: CheckpointRow): BrowserCheckpointRecord | null {
  const ref = browserCheckpointRefSchema.safeParse({
    kind: row.kind,
    objectId: row.object_id,
    editUrl: row.edit_url,
  })
  if (!ref.success) return null
  const verified =
    row.state === 'verified' ? browserVerifiedObjectSchema.safeParse(row.verified) : null
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    ref: ref.data,
    state: row.state,
    verified: verified?.success ? verified.data : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
