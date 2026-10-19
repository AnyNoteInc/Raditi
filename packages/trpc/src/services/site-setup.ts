import { clientIp } from '@repo/auth'
import { enqueueSiteProvisioningStage, type Prisma, type SiteStatus } from '@repo/db'
import {
  connectionTlsModes,
  DomainError,
  importSkipReasons,
  provisioningErrorCodes,
  provisioningStageStatuses,
  provisioningStageSummarySchema,
  provisioningSteps,
  siteConnectionLimits,
  siteSetupState,
  siteSourceKinds,
  type ProvisioningErrorCode,
  type ProvisioningStep,
} from '@repo/domain'
import { z } from 'zod'

import { accessibleSite, siteNotFound } from './site-basics.ts'

// The screen «Настраиваем сайт» (docs/plan/39-site-connection-wizard.md): what the first import of a site
// is doing, how it ended, and what the user may do about a failure — «Повторить» and «Изменить доступ»,
// together at most retriesPerHour times an hour. The truth is the code_import row of
// site_provisioning_stages; the counter of the hour is the audit log of these two actions.

/** The audit actions that spend the hourly budget of a site. */
export const SETUP_RETRY_ACTION = 'site.setup.retry'
export const ACCESS_REPLACE_ACTION = 'site.access.replace'
const HOUR_MS = 60 * 60_000

export const siteSetupStates = ['pending', 'failed', 'done'] as const

/** The first version of the repository once `main` and its tag are confirmed on the remote. */
export const initialVersionOutput = z
  .object({ tag: z.string(), commitSha: z.string(), importedAt: z.date() })
  .nullable()

export const setupOutput = z.object({
  /** null: a site without the stage (created before the wizard) lives as it did. */
  state: z.enum(siteSetupStates).nullable(),
  status: z.enum(provisioningStageStatuses).nullable(),
  step: z.enum(provisioningSteps).nullable(),
  errorCode: z.enum(provisioningErrorCodes).nullable(),
  attempt: z.number().int().nullable(),
  updatedAt: z.date().nullable(),
  /** `limited`: failed, and «Повторить» or «Изменить доступ» was used retriesPerHour times this hour. */
  retry: z.enum(['available', 'limited', 'unavailable']),
  /** «Изменить доступ» spends the same budget: offered exactly when `retry` is `available`. */
  replaceAccess: z.boolean(),
  /** The public columns of the source; the user name and every secret stay in Vault. */
  source: z
    .object({
      kind: z.enum(siteSourceKinds),
      host: z.string(),
      port: z.number().int(),
      rootPath: z.string(),
      tls: z.enum(connectionTlsModes).nullable(),
      hostKey: z.string().nullable(),
    })
    .nullable(),
  initialVersion: initialVersionOutput,
  summary: z
    .object({
      files: z.number().int().nonnegative().optional(),
      bytes: z.number().int().nonnegative().optional(),
      skipped: z
        .partialRecord(z.enum(importSkipReasons), z.number().int().nonnegative())
        .optional(),
    })
    .nullable(),
})
export type SiteSetup = z.infer<typeof setupOutput>

export const codeImportOnly = { where: { stage: 'code_import' } } as const

const setupSelect = {
  id: true,
  status: true,
  provisioningStages: {
    ...codeImportOnly,
    select: {
      status: true,
      step: true,
      errorCode: true,
      attempt: true,
      updatedAt: true,
      summary: true,
    },
  },
  codeSource: {
    select: { kind: true, host: true, port: true, rootPath: true, tls: true, hostKey: true },
  },
  initialVersion: { select: { tag: true, commitSha: true, importedAt: true } },
} satisfies Prisma.SiteSelect

type SetupRow = Prisma.SiteGetPayload<{ select: typeof setupSelect }>

/** The stored version only once it is confirmed: a commit written before the push is not one yet. */
export function confirmedInitialVersion(
  row: { tag: string; commitSha: string; importedAt: Date | null } | null | undefined,
): z.infer<typeof initialVersionOutput> {
  if (!row?.importedAt) return null
  return { tag: row.tag, commitSha: row.commitSha, importedAt: row.importedAt }
}

const knownCode = (code: string): ProvisioningErrorCode =>
  (provisioningErrorCodes as readonly string[]).includes(code)
    ? (code as ProvisioningErrorCode)
    : 'internal'

const knownStep = (step: string | null): ProvisioningStep | null =>
  step !== null && (provisioningSteps as readonly string[]).includes(step)
    ? (step as ProvisioningStep)
    : null

/** Counts only; a summary that does not pass its schema shows as none. */
function summaryOf(value: Prisma.JsonValue | null): SiteSetup['summary'] {
  if (value === null) return null
  const parsed = provisioningStageSummarySchema.safeParse(value)
  if (!parsed.success) return null
  const { files, bytes, skipped } = parsed.data
  return {
    ...(files === undefined ? {} : { files }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(skipped === undefined ? {} : { skipped }),
  }
}

/** «Повторить» and «Изменить доступ» of this site within the last hour. */
export function retriesThisHour(
  db: Pick<Prisma.TransactionClient, 'auditLog'>,
  siteId: string,
): Promise<number> {
  return db.auditLog.count({
    where: {
      targetType: 'site',
      targetId: siteId,
      action: { in: [SETUP_RETRY_ACTION, ACCESS_REPLACE_ACTION] },
      createdAt: { gt: new Date(Date.now() - HOUR_MS) },
    },
  })
}

/** Only a failed import of a site that is still being connected is offered again. */
const canRetry = (site: { status: SiteStatus }, stage: { status: string } | undefined) =>
  stage?.status === 'failed' && site.status === 'onboarding'

function setupOf(row: SetupRow, retries: number): SiteSetup {
  const stage = row.provisioningStages[0]
  const failed = canRetry(row, stage)
  const source = row.codeSource
  const budgetLeft = retries < siteConnectionLimits.retriesPerHour
  return {
    state: siteSetupState(stage),
    status: stage?.status ?? null,
    step: knownStep(stage?.step ?? null),
    errorCode: stage?.errorCode == null ? null : knownCode(stage.errorCode),
    attempt: stage?.attempt ?? null,
    updatedAt: stage?.updatedAt ?? null,
    retry: !failed ? 'unavailable' : budgetLeft ? 'available' : 'limited',
    // assertRetryable refuses both actions alike once the hour is spent: never a button it refuses.
    replaceAccess: failed && budgetLeft,
    source:
      // A source with a folder (site_code_sources_shape_check): what «Изменить доступ» starts from.
      source && source.rootPath !== null
        ? {
            kind: source.kind,
            host: source.host,
            port: source.port,
            rootPath: source.rootPath,
            tls: source.tls,
            hostKey: source.hostKey,
          }
        : null,
    initialVersion: confirmedInitialVersion(row.initialVersion),
    summary: stage ? summaryOf(stage.summary) : null,
  }
}

/** The setup of a site the user can open; NOT_FOUND for any other, as project.get answers. */
export async function readSiteSetup(
  db: Pick<Prisma.TransactionClient, 'site' | 'auditLog'>,
  userId: string,
  siteId: string,
): Promise<SiteSetup> {
  const row = await db.site.findFirst({
    where: accessibleSite(userId, siteId),
    select: setupSelect,
  })
  if (!row) throw siteNotFound()
  const retries = canRetry(row, row.provisioningStages[0]) ? await retriesThisHour(db, row.id) : 0
  return setupOf(row, retries)
}

export const notFailed = () =>
  new DomainError('SITE_SETUP_NOT_FAILED', 'The import of the site has not failed', 409)

/**
 * What «Повторить» and «Изменить доступ» ask before anything is written: the import failed, the site is
 * still being connected, and the hour has budget left. The guarded statement of the requeue decides again.
 */
export async function assertRetryable(
  db: Pick<Prisma.TransactionClient, 'auditLog'>,
  site: { id: string; status: SiteStatus; provisioningStages: { status: string }[] },
): Promise<void> {
  const stage = site.provisioningStages[0]
  if (stage?.status !== 'failed') throw notFailed()
  if (site.status !== 'onboarding') {
    throw new DomainError(
      'SITE_SETUP_UNAVAILABLE',
      'The site is no longer being connected: its import is not retried',
      409,
    )
  }
  if ((await retriesThisHour(db, site.id)) >= siteConnectionLimits.retriesPerHour) {
    throw new DomainError(
      'SITE_SETUP_RETRIES_LIMITED',
      'The import of the site was retried too often this hour',
      429,
    )
  }
}

/**
 * The next attempt of a failed code_import: queued again with a fresh event counter, the marks of the
 * finished run cleared, the summary kept. Guarded by `status = 'failed'` of a site still `onboarding`, so of
 * two concurrent retries one requeues and the other finds nothing; then its outbox event and its audit
 * entry, in the caller's transaction. Returns the new attempt.
 */
export async function requeueFailedImport(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | 'outboxEvent' | 'auditLog'>,
  entry: {
    siteId: string
    workspaceId: string
    userId: string
    headers: Headers
    action: typeof SETUP_RETRY_ACTION | typeof ACCESS_REPLACE_ACTION
    meta: Prisma.InputJsonObject
  },
): Promise<number> {
  const { siteId } = entry
  const rows = await tx.$queryRaw<{ attempt: number }[]>`
    UPDATE site_provisioning_stages
    SET status = 'queued', attempt = attempt + 1, enqueues = 1, error_code = NULL,
        started_at = NULL, finished_at = NULL, heartbeat_at = NULL, step = NULL, updated_at = now()
    WHERE site_id = ${siteId}::uuid AND stage = 'code_import' AND status = 'failed'
      AND EXISTS (
        SELECT 1 FROM sites WHERE sites.id = site_provisioning_stages.site_id AND sites.status = 'onboarding'
      )
    RETURNING attempt
  `
  const attempt = rows[0]?.attempt
  if (attempt === undefined) throw notFailed()
  await enqueueSiteProvisioningStage(tx, { siteId, stage: 'code_import', attempt, enqueues: 1 })
  await tx.auditLog.create({
    data: {
      actorType: 'user',
      actorId: entry.userId,
      workspaceId: entry.workspaceId,
      action: entry.action,
      targetType: 'site',
      targetId: siteId,
      meta: entry.meta,
      ip: clientIp(entry.headers),
    },
  })
  return attempt
}
