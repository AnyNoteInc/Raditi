import { createHash, randomBytes } from 'node:crypto'

import type { PrismaClient } from '@repo/db'
import {
  previewBrowserSecretPath,
  previewBrowserSecretSchema,
  previewEnterUrl,
  previewTimings,
  type PreviewRuntime,
  type SecretStore,
} from '@repo/domain'

import type { PreviewsConfig } from '../config/config.ts'
import { previewOriginOf } from './preview-builder.ts'
import { isBusyTask, type PreviewFacts } from './preview-facts.ts'
import type { PreviewHold } from './preview-lease.ts'

// The agent's browser on its preview (docs/plan/53-chat-preview-release.md, Р21): the mcp role
// asks for one with a row of `preview_browser_requests`; core starts the browser's containers,
// issues a service ticket of the gateway for this row (`kind = browser`, no user) and puts where
// the browser is and how it enters into Vault `kv/previews/<previewId>/browser` — only then the
// row is `ready`. A browser nobody used for 15 minutes is stopped.

export interface PreviewBrowserDeps {
  db: PrismaClient
  config: PreviewsConfig
  runtime: PreviewRuntime | null
  secrets: Pick<SecretStore, 'kvRead' | 'kvWrite' | 'kvDestroyAll'>
}

/** Why a browser request was refused (`preview_browser_requests.error_code`). */
export const previewBrowserRefusals = [
  'not_ready',
  'no_turn',
  'not_configured',
  'busy',
  'failed',
] as const
export type PreviewBrowserRefusal = (typeof previewBrowserRefusals)[number]

export class PreviewBrowserRefused extends Error {
  constructor(readonly code: PreviewBrowserRefusal) {
    super(`Preview browser refused: ${code}`)
    this.name = 'PreviewBrowserRefused'
  }
}

export const previewBrowserErrorCode = (error: unknown): PreviewBrowserRefusal =>
  error instanceof PreviewBrowserRefused ? error.code : 'failed'

const CONTROL = /^(ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4})(\/[A-Za-z0-9_-]{43,128})$/

/** A service ticket of the gateway for the agent's browser: 32 random bytes, its hash kept. */
async function browserTicket(db: PrismaClient, previewId: string): Promise<string> {
  const ticket = randomBytes(32).toString('base64url')
  await db.previewTicket.create({
    data: {
      previewId,
      userId: null,
      kind: 'browser',
      tokenHash: createHash('sha256').update(ticket).digest('hex'),
      expiresAt: new Date(Date.now() + previewTimings.ticketSeconds * 1000),
    },
  })
  return ticket
}

/** Starts the browser of the preview for one request row and answers it (`ready_at`). */
export async function startPreviewBrowser(
  deps: PreviewBrowserDeps,
  hold: PreviewHold,
  facts: PreviewFacts,
  request: { id: string; assignmentId: string | null },
): Promise<void> {
  const { preview } = facts
  if (preview.status !== 'ready' || !preview.upstream) throw new PreviewBrowserRefused('not_ready')
  if (!isBusyTask(facts.task.status) || !request.assignmentId)
    throw new PreviewBrowserRefused('no_turn')
  const assignment = await deps.db.turnAssignment.findUnique({
    where: { id: request.assignmentId },
    select: { taskId: true, finishedAt: true },
  })
  if (!assignment || assignment.taskId !== preview.taskId || assignment.finishedAt !== null)
    throw new PreviewBrowserRefused('no_turn')
  const image = deps.config.images.browser
  if (!deps.runtime || !image) throw new PreviewBrowserRefused('not_configured')

  const endpoint = await deps.runtime.startBrowser(preview.id, {
    image,
    hostname: preview.hostname,
  })
  const control = CONTROL.exec(endpoint.wsEndpoint)
  if (!control) throw new PreviewBrowserRefused('failed')
  hold.assert()
  const ticket = await browserTicket(deps.db, preview.id)
  const secret = previewBrowserSecretSchema.parse({
    v: '1',
    requestId: request.id,
    wsEndpoint: control[1],
    wsPath: control[2],
    enterUrl: previewEnterUrl(previewOriginOf(deps.config, preview.hostname), ticket, '/'),
  })
  const path = previewBrowserSecretPath(preview.id)
  const current = await deps.secrets.kvRead(path)
  await deps.secrets.kvWrite(path, secret, { cas: current?.version ?? 0 })
  hold.assert()
  await deps.db.previewBrowserRequest.updateMany({
    where: { id: request.id, readyAt: null, stoppedAt: null, errorCode: null },
    data: { readyAt: new Date() },
  })
}

/** Stops the browser of the preview and closes every request of it (idle, or the dialog ended). */
export async function stopPreviewBrowser(
  deps: PreviewBrowserDeps,
  hold: PreviewHold,
  previewId: string,
): Promise<void> {
  if (deps.runtime) await deps.runtime.stopBrowser(previewId)
  await deps.secrets.kvDestroyAll(previewBrowserSecretPath(previewId))
  hold.assert()
  await deps.db.previewBrowserRequest.updateMany({
    where: { previewId, stoppedAt: null },
    data: { stoppedAt: new Date() },
  })
}

/**
 * Previews whose browser runs and was not used for `previewTimings.browserIdleMinutes`: no new
 * request of the agent, no request of its session at the gateway (Р21).
 */
export async function idleBrowsers(db: PrismaClient, limit: number): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT p.id FROM preview_environments p
    WHERE EXISTS (SELECT 1 FROM preview_browser_requests r
        WHERE r.preview_id = p.id AND r.ready_at IS NOT NULL AND r.stopped_at IS NULL)
      AND GREATEST(
        (SELECT max(r.requested_at) FROM preview_browser_requests r WHERE r.preview_id = p.id),
        (SELECT max(COALESCE(s.checked_at, s.created_at)) FROM preview_sessions s
          WHERE s.preview_id = p.id AND s.kind = 'browser')
      ) < now() - make_interval(mins => ${previewTimings.browserIdleMinutes})
    LIMIT ${limit}`
  return rows.map((row) => row.id)
}
