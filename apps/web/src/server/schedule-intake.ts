import 'server-only'

import { createHash, timingSafeEqual } from 'node:crypto'

import {
  isDomainError,
  SCHEDULE_INTAKE_MAX_BYTES,
  SCHEDULE_INTAKE_SECRET_HEADER,
  scheduleIntakeRequestSchema,
  type ScheduleIntakeRequest,
  type ScheduleIntakeResponse,
} from '@repo/domain'

import { readBodyWithin } from './body-limit'

// The runs of scheduled tasks (docs/plan/82-scheduled-tasks.md, Зп19, §4.3): core writes a run with a
// snapshot of its task and posts its id here with the secret both read; web starts its chat by the
// same `createDialog` as the cabinet. 200 — the answer of the run, done or recorded before; 400 and
// 413 — core gives the run up (a fault of the platform); 401, 404 and 503 — core asks again.

export interface ScheduleIntakeRoute {
  /** null — SCHEDULE_INTAKE_SECRET is unset: no runs are taken here, the route answers 404. */
  secret: string | null
  start: (request: ScheduleIntakeRequest) => Promise<ScheduleIntakeResponse>
  logError?: (line: string) => void
}

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** The secret of the request against the configured one, in constant time and length (sha256). */
export function scheduleSecretMatches(received: string | null, expected: string): boolean {
  if (!received) return false
  const a = createHash('sha256').update(received, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

export async function handleScheduleIntake(
  request: Request,
  route: ScheduleIntakeRoute,
): Promise<Response> {
  if (route.secret === null) return json(404, { ok: false })
  if (!scheduleSecretMatches(request.headers.get(SCHEDULE_INTAKE_SECRET_HEADER), route.secret))
    return json(401, { ok: false })
  let body: Buffer | null
  try {
    body = await readBodyWithin(request, SCHEDULE_INTAKE_MAX_BYTES)
  } catch {
    // A body that broke off: core sends it again.
    return json(503, { ok: false })
  }
  if (body === null) return json(413, { ok: false })
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return json(400, { ok: false })
  }
  const run = scheduleIntakeRequestSchema.safeParse(parsed)
  if (!run.success) return json(400, { ok: false })
  try {
    return json(200, await route.start(run.data))
  } catch (error) {
    // The id of the run and the class of the failure only: never the words of the task.
    const cause = isDomainError(error) ? error.code : error instanceof Error ? error.name : 'Error'
    ;(route.logError ?? ((line) => console.error(line)))(
      `[schedule] run ${run.data.runId} failed: ${cause}`,
    )
    return json(503, { ok: false })
  }
}
