import { activateSite, enqueueSiteProvisioningStage, type Prisma, type PrismaClient } from '@repo/db'
import {
  INITIAL_SITE_TAG,
  provisioningLimits,
  provisioningStageSummarySchema,
  siteAccessKinds,
  type DatabaseEngine,
  type GitProviderKind,
  type ProvisioningErrorCode,
  type ProvisioningStageSummary,
  type ProvisioningStep,
  type SiteSourceKind,
  type SiteStack,
} from '@repo/domain'
import { z } from 'zod'

import { LeaseLost, refuse } from './import-failure.ts'

// The code_import row of site_provisioning_stages is the truth about an import
// (docs/plan/39-site-connection-wizard.md): a job only says «look at this site». Every write of a
// run is fenced — its transaction locks the stage row and finds it still `running` under the
// epoch the run claimed — so a run that was given up on can no longer change anything. Every
// statement over many stages names `finished_at IS NULL`: the partial index serves only those.

/** The stage this store keeps; database_schema has its own worker (not in this slice). */
const STAGE = 'code_import' as const

type Transaction = Prisma.TransactionClient

/** The run that holds a stage: its site and the epoch its claim made. */
export interface StageLease {
  siteId: string
  leaseEpoch: number
}

export interface ClaimedStage extends StageLease {
  workspaceId: string
  stack: SiteStack
  /** sites.url: the public address, for SiteAdapter.importRules. */
  url: string
  attempt: number
  enqueues: number
}

export type ClaimResult =
  | { kind: 'claimed'; stage: ClaimedStage }
  /** Not queued (running elsewhere, finished, or no such stage): the job was only a hint. */
  | { kind: 'idle' }
  /** Another import of the workspace runs; this stage waits for the wake-up at its end. */
  | { kind: 'busy' }
  /** The site is no longer being connected: the stage failed `access_refused`. */
  | { kind: 'refused'; workspaceId: string; leaseEpoch: number }

/** The public columns of site_code_sources, flat. */
export interface StoredSource {
  kind: SiteSourceKind
  host: string
  port: number
  rootPath: string | null
  repositoryUrl: string | null
  branch: string | null
  tls: 'verified' | 'unverified' | 'plain' | null
  hostKey: string | null
  credentialRefId: string
}

export interface StoredReference {
  kind: string
  siteId: string | null
  workspaceId: string | null
  vaultPath: string
  keyVersion: number
}

/** The public columns of site_databases. */
export interface StoredDatabase {
  engine: DatabaseEngine
  host: string
  port: number
  databaseName: string
  tls: 'verified' | 'unverified' | 'plain'
  credentialRefId: string
}

export interface StoredAccess {
  siteStatus: string
  workspaceId: string
  source: StoredSource | null
  reference: StoredReference | null
  /** null — the site has no database row: there is no database password to look for. */
  database: { row: StoredDatabase; reference: StoredReference | null } | null
}

/** site_initial_versions: the commit an import is publishing, or has published. */
export interface InitialVersionPlan {
  gitRepositoryId: string
  commitSha: string
  files: number
  bytes: number
  leaseEpoch: number
  importedAt: Date | null
}

export interface RecordedRepository {
  provider: GitProviderKind
  owner: string
  name: string
  /** Web address of the repository, without `.git`. */
  url: string
}

/** A stage the sweep moved, with what the wake-up of its workspace needs. */
export interface SweptStage {
  siteId: string
  workspaceId: string
  attempt: number
  enqueues: number
  leaseEpoch: number
}

export type RequeueOutcome = 'requeued' | 'failed'

/** What the import worker, the sweep and their tests need of PostgreSQL. */
export interface SiteImportStore {
  claim(siteId: string): Promise<ClaimResult>
  /** false — the run no longer holds the stage. */
  heartbeat(lease: StageLease): Promise<boolean>
  setStep(lease: StageLease, step: ProvisioningStep): Promise<void>
  readAccess(lease: StageLease): Promise<StoredAccess>
  /** The id of the repository row of the site; a name another site holds is refused. */
  recordRepository(lease: StageLease, repository: RecordedRepository): Promise<string>
  readPlan(siteId: string): Promise<InitialVersionPlan | null>
  /** The commit about to be pushed, with the counts of the walk; never over an imported one. */
  recordPlan(
    lease: StageLease,
    plan: { gitRepositoryId: string; commitSha: string; files: number; bytes: number },
    summary: ProvisioningStageSummary,
  ): Promise<void>
  succeed(lease: StageLease, commitSha: string): Promise<void>
  fail(lease: StageLease, code: ProvisioningErrorCode): Promise<void>
  /** A hiccup: back to the queue after `delayMs`, or failed with `code` once the enqueues are used. */
  retry(lease: StageLease, code: ProvisioningErrorCode, delayMs: number): Promise<RequeueOutcome>
  /** Shutdown: back to the queue after releaseDelayMs, or failed `interrupted` at the limit. */
  release(lease: StageLease): Promise<RequeueOutcome>
  /** The oldest queued import of the workspace other than `exceptSiteId`. */
  nextQueued(
    workspaceId: string,
    exceptSiteId: string,
  ): Promise<{ siteId: string; attempt: number } | null>
  /** Running stages without a heartbeat for staleMs: requeued, or failed `interrupted`. */
  sweepSilent(): Promise<{ requeued: SweptStage[]; interrupted: SweptStage[] }>
  /** Queued stages untouched for queuedStaleMs. */
  waiting(): Promise<{ siteId: string; attempt: number }[]>
}

const SWEEP_BATCH = 100

const claimRowSchema = z.object({
  status: z.string(),
  attempt: z.number().int(),
  enqueues: z.number().int(),
  lease_epoch: z.number().int(),
  site_status: z.string(),
  stack: z.string(),
  url: z.string(),
  workspace_id: z.string(),
})
const leaseRowSchema = z.object({
  lease_epoch: z.number().int(),
  attempt: z.number().int(),
  enqueues: z.number().int(),
})
const sweptRowSchema = z.object({
  site_id: z.string(),
  workspace_id: z.string(),
  attempt: z.number().int(),
  enqueues: z.number().int(),
  lease_epoch: z.number().int(),
})
const counterRowSchema = z.object({
  attempt: z.number().int(),
  enqueues: z.number().int(),
})

/** Keeps the summary within what the row accepts (its CHECK and provisioningStageSummarySchema). */
const summaryJson = (summary: ProvisioningStageSummary): string =>
  JSON.stringify(provisioningStageSummarySchema.parse(summary))

export class PostgresSiteImportStore implements SiteImportStore {
  readonly #prisma: PrismaClient

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma
  }

  /** Short locks and statements: a stuck lock fails the call, it never holds a worker. */
  #transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.#prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', '2000ms', true),
          set_config('statement_timeout', '10000ms', true)`
        return operation(tx)
      },
      { maxWait: 2_000, timeout: 15_000 },
    )
  }

  /** The transaction of one write of a run: the stage row locked and still held, or LeaseLost. */
  #fenced<T>(lease: StageLease, operation: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.#transaction(async (tx) => {
      const held = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM site_provisioning_stages
        WHERE site_id = ${lease.siteId}::uuid AND stage = 'code_import'
          AND status = 'running' AND lease_epoch = ${lease.leaseEpoch}::int
          AND finished_at IS NULL
        FOR UPDATE`
      if (held.length !== 1) throw new LeaseLost()
      return operation(tx)
    })
  }

  async claim(siteId: string): Promise<ClaimResult> {
    return this.#transaction(async (tx) => {
      // The workspace first: two sites of one workspace never both pass the check below.
      const workspace = await tx.$queryRaw<{ id: string }[]>`
        SELECT w.id::text AS id FROM workspaces w JOIN sites s ON s.workspace_id = w.id
        WHERE s.id = ${siteId}::uuid
        FOR NO KEY UPDATE OF w`
      if (workspace.length !== 1) return { kind: 'idle' }
      const rows = await tx.$queryRaw<unknown[]>`
        SELECT st.status::text AS status, st.attempt, st.enqueues, st.lease_epoch,
               s.status::text AS site_status, s.stack::text AS stack, s.url,
               s.workspace_id::text AS workspace_id
        FROM site_provisioning_stages st JOIN sites s ON s.id = st.site_id
        WHERE st.site_id = ${siteId}::uuid AND st.stage = 'code_import' AND st.finished_at IS NULL
        FOR UPDATE OF st`
      if (rows.length !== 1) return { kind: 'idle' }
      const row = claimRowSchema.parse(rows[0])
      if (row.status !== 'queued') return { kind: 'idle' }
      if (row.site_status !== 'onboarding') {
        await tx.$executeRaw`
          UPDATE site_provisioning_stages
          SET status = 'failed', error_code = 'access_refused', finished_at = now(), step = NULL,
              heartbeat_at = NULL, updated_at = now()
          WHERE site_id = ${siteId}::uuid AND stage = 'code_import' AND status = 'queued'
            AND finished_at IS NULL`
        return { kind: 'refused', workspaceId: row.workspace_id, leaseEpoch: row.lease_epoch }
      }
      const running = await tx.$queryRaw<{ running: number }[]>`
        SELECT count(*)::int AS running
        FROM site_provisioning_stages st JOIN sites s ON s.id = st.site_id
        WHERE s.workspace_id = ${row.workspace_id}::uuid AND st.stage = 'code_import'
          AND st.status = 'running' AND st.finished_at IS NULL`
      if ((running[0]?.running ?? 0) >= provisioningLimits.importsPerWorkspace)
        return { kind: 'busy' }
      const claimed = await tx.$queryRaw<unknown[]>`
        UPDATE site_provisioning_stages
        SET status = 'running', lease_epoch = lease_epoch + 1, heartbeat_at = now(),
            started_at = COALESCE(started_at, now()), step = 'fetch', updated_at = now()
        WHERE site_id = ${siteId}::uuid AND stage = 'code_import' AND status = 'queued'
          AND finished_at IS NULL
        RETURNING lease_epoch, attempt, enqueues`
      if (claimed.length !== 1) return { kind: 'idle' }
      const lease = leaseRowSchema.parse(claimed[0])
      return {
        kind: 'claimed',
        stage: {
          siteId: siteId.toLowerCase(),
          workspaceId: row.workspace_id,
          stack: row.stack as SiteStack,
          url: row.url,
          attempt: lease.attempt,
          enqueues: lease.enqueues,
          leaseEpoch: lease.lease_epoch,
        },
      }
    })
  }

  async heartbeat(lease: StageLease): Promise<boolean> {
    const count = await this.#prisma.$executeRaw`
      UPDATE site_provisioning_stages SET heartbeat_at = now()
      WHERE site_id = ${lease.siteId}::uuid AND stage = 'code_import' AND status = 'running'
        AND lease_epoch = ${lease.leaseEpoch}::int AND finished_at IS NULL`
    return count === 1
  }

  async setStep(lease: StageLease, step: ProvisioningStep): Promise<void> {
    await this.#fenced(lease, async (tx) => {
      await tx.$executeRaw`
        UPDATE site_provisioning_stages SET step = ${step}, updated_at = now()
        WHERE site_id = ${lease.siteId}::uuid AND stage = 'code_import'`
    })
  }

  async readAccess(lease: StageLease): Promise<StoredAccess> {
    return this.#fenced(lease, async (tx) => {
      const site = await tx.site.findUnique({
        where: { id: lease.siteId },
        select: {
          status: true,
          workspaceId: true,
          codeSource: {
            select: {
              kind: true,
              host: true,
              port: true,
              rootPath: true,
              repositoryUrl: true,
              branch: true,
              tls: true,
              hostKey: true,
              credentialRefId: true,
            },
          },
          database: {
            select: {
              engine: true,
              host: true,
              port: true,
              databaseName: true,
              tls: true,
              credentialRefId: true,
            },
          },
        },
      })
      if (!site) throw refuse('access_missing')
      const referenceOf = (id: string) =>
        tx.credentialRef.findUnique({
          where: { id },
          select: {
            kind: true,
            siteId: true,
            workspaceId: true,
            vaultPath: true,
            keyVersion: true,
          },
        })
      return {
        siteStatus: site.status,
        workspaceId: site.workspaceId,
        source: site.codeSource,
        reference: site.codeSource ? await referenceOf(site.codeSource.credentialRefId) : null,
        database: site.database
          ? { row: site.database, reference: await referenceOf(site.database.credentialRefId) }
          : null,
      }
    })
  }

  async recordRepository(lease: StageLease, repository: RecordedRepository): Promise<string> {
    return this.#fenced(lease, async (tx) => {
      const key = {
        provider: repository.provider,
        owner: repository.owner,
        name: repository.name,
      }
      const existing = await tx.gitRepository.findUnique({
        where: { provider_owner_name: key },
        select: { id: true, siteId: true, url: true, defaultBranch: true },
      })
      if (existing) {
        // The name is derived from the site id: a row of another site is not this repository.
        if (existing.siteId !== lease.siteId) throw refuse('repository_not_created')
        if (existing.url !== repository.url || existing.defaultBranch !== 'main')
          await tx.gitRepository.update({
            where: { id: existing.id },
            data: { url: repository.url, defaultBranch: 'main' },
          })
        return existing.id
      }
      const created = await tx.gitRepository.create({
        data: { ...key, siteId: lease.siteId, defaultBranch: 'main', url: repository.url },
        select: { id: true },
      })
      return created.id
    })
  }

  async readPlan(siteId: string): Promise<InitialVersionPlan | null> {
    const plan = await this.#prisma.siteInitialVersion.findUnique({
      where: { siteId },
      select: {
        gitRepositoryId: true,
        commitSha: true,
        files: true,
        bytes: true,
        leaseEpoch: true,
        importedAt: true,
      },
    })
    return plan
  }

  async recordPlan(
    lease: StageLease,
    plan: { gitRepositoryId: string; commitSha: string; files: number; bytes: number },
    summary: ProvisioningStageSummary,
  ): Promise<void> {
    const json = summaryJson(summary)
    await this.#fenced(lease, async (tx) => {
      // A plan that was never published may be replaced; a published one never is.
      const written = await tx.$executeRaw`
        INSERT INTO site_initial_versions
          (site_id, git_repository_id, commit_sha, tag, files, bytes, lease_epoch, imported_at,
           updated_at)
        VALUES (${lease.siteId}::uuid, ${plan.gitRepositoryId}::uuid, ${plan.commitSha},
                ${INITIAL_SITE_TAG}, ${plan.files}::int, ${plan.bytes}::int,
                ${lease.leaseEpoch}::int, NULL, now())
        ON CONFLICT (site_id) DO UPDATE SET
          git_repository_id = EXCLUDED.git_repository_id, commit_sha = EXCLUDED.commit_sha,
          tag = EXCLUDED.tag, files = EXCLUDED.files, bytes = EXCLUDED.bytes,
          lease_epoch = EXCLUDED.lease_epoch, updated_at = now()
        WHERE site_initial_versions.imported_at IS NULL`
      if (written !== 1) throw refuse('repository_mismatch')
      await tx.$executeRaw`
        UPDATE site_provisioning_stages SET summary = ${json}::jsonb, updated_at = now()
        WHERE site_id = ${lease.siteId}::uuid AND stage = 'code_import'`
    })
  }

  async succeed(lease: StageLease, commitSha: string): Promise<void> {
    await this.#fenced(lease, async (tx) => {
      const confirmed = await tx.$executeRaw`
        UPDATE site_initial_versions
        SET imported_at = COALESCE(imported_at, now()), updated_at = now()
        WHERE site_id = ${lease.siteId}::uuid AND commit_sha = ${commitSha}`
      // The remote holds a commit the row does not name: never a success.
      if (confirmed !== 1) throw refuse('repository_mismatch')
      await tx.$executeRaw`
        UPDATE site_provisioning_stages
        SET status = 'succeeded', finished_at = now(), step = NULL, heartbeat_at = NULL,
            error_code = NULL, updated_at = now()
        WHERE site_id = ${lease.siteId}::uuid AND stage = 'code_import'`
      await this.#installFirstVersion(tx, lease.siteId, commitSha)
    })
  }

  /**
   * The first version is what the hosting holds (owner's decision of 26.10.2026: «чат должен
   * быть разблокирован»): it becomes the installed version — `v0.0.0` of the import, without a
   * release (CHECK sites_installed_check) — and a site still `onboarding` with its repository
   * and the reference of its file access takes tasks (`activateSite`). A site that already has
   * an installed version, or another status, is left as it is.
   */
  async #installFirstVersion(tx: Transaction, siteId: string, commitSha: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE sites
      SET installed_version = ${INITIAL_SITE_TAG}, installed_sha = ${commitSha},
          installed_at = now(), installed_release_id = NULL, updated_at = now()
      WHERE id = ${siteId}::uuid AND status = 'onboarding' AND installed_version IS NULL`
    const source = z
      .array(z.object({ kind: z.enum(siteAccessKinds) }))
      .parse(
        await tx.$queryRaw`
          SELECT c.kind::text AS kind FROM site_code_sources s
          JOIN credential_refs c ON c.id = s.credential_ref_id
          WHERE s.site_id = ${siteId}::uuid`,
      )[0]
    if (source) await activateSite(tx, { siteId, requiredAccess: [source.kind] })
  }

  async fail(lease: StageLease, code: ProvisioningErrorCode): Promise<void> {
    await this.#fenced(lease, (tx) => this.#failHeld(tx, lease.siteId, code))
  }

  async #failHeld(tx: Transaction, siteId: string, code: ProvisioningErrorCode): Promise<void> {
    await tx.$executeRaw`
      UPDATE site_provisioning_stages
      SET status = 'failed', error_code = ${code}, finished_at = now(), step = NULL,
          heartbeat_at = NULL, updated_at = now()
      WHERE site_id = ${siteId}::uuid AND stage = 'code_import'`
  }

  /** Back to `queued` with one more enqueue and its outbox event, or failed at the limit. */
  async #requeueHeld(
    tx: Transaction,
    siteId: string,
    code: ProvisioningErrorCode,
    delayMs: number,
  ): Promise<RequeueOutcome> {
    const requeued = await tx.$queryRaw<unknown[]>`
      UPDATE site_provisioning_stages
      SET status = 'queued', enqueues = enqueues + 1, step = NULL, heartbeat_at = NULL,
          updated_at = now()
      WHERE site_id = ${siteId}::uuid AND stage = 'code_import'
        AND enqueues < ${provisioningLimits.enqueuesPerAttempt}::int
      RETURNING attempt, enqueues`
    if (requeued.length === 0) {
      await this.#failHeld(tx, siteId, code)
      return 'failed'
    }
    const counters = counterRowSchema.parse(requeued[0])
    await enqueueSiteProvisioningStage(tx, {
      siteId,
      stage: STAGE,
      attempt: counters.attempt,
      enqueues: counters.enqueues,
      availableAt: new Date(Date.now() + delayMs),
    })
    return 'requeued'
  }

  async retry(
    lease: StageLease,
    code: ProvisioningErrorCode,
    delayMs: number,
  ): Promise<RequeueOutcome> {
    return this.#fenced(lease, (tx) => this.#requeueHeld(tx, lease.siteId, code, delayMs))
  }

  async release(lease: StageLease): Promise<RequeueOutcome> {
    return this.#fenced(lease, (tx) =>
      this.#requeueHeld(tx, lease.siteId, 'interrupted', provisioningLimits.releaseDelayMs),
    )
  }

  async nextQueued(
    workspaceId: string,
    exceptSiteId: string,
  ): Promise<{ siteId: string; attempt: number } | null> {
    const rows = await this.#prisma.$queryRaw<{ site_id: string; attempt: number }[]>`
      SELECT st.site_id::text AS site_id, st.attempt
      FROM site_provisioning_stages st JOIN sites s ON s.id = st.site_id
      WHERE st.finished_at IS NULL AND st.stage = 'code_import' AND st.status = 'queued'
        AND s.workspace_id = ${workspaceId}::uuid AND st.site_id <> ${exceptSiteId}::uuid
      ORDER BY st.updated_at, st.site_id
      LIMIT 1`
    const row = rows[0]
    return row ? { siteId: row.site_id, attempt: row.attempt } : null
  }

  async sweepSilent(): Promise<{ requeued: SweptStage[]; interrupted: SweptStage[] }> {
    const silence = provisioningLimits.staleMs
    return this.#transaction(async (tx) => {
      const requeued = z.array(sweptRowSchema).parse(
        await tx.$queryRaw`
          WITH silent AS (
            SELECT site_id FROM site_provisioning_stages
            WHERE finished_at IS NULL AND stage = 'code_import' AND status = 'running'
              AND enqueues < ${provisioningLimits.enqueuesPerAttempt}::int
              AND heartbeat_at < now() - ${silence}::int * interval '1 millisecond'
            ORDER BY heartbeat_at
            LIMIT ${SWEEP_BATCH}::int
            FOR UPDATE SKIP LOCKED
          )
          UPDATE site_provisioning_stages st
          SET status = 'queued', enqueues = st.enqueues + 1, step = NULL, heartbeat_at = NULL,
              updated_at = now()
          FROM silent JOIN sites s ON s.id = silent.site_id
          WHERE st.site_id = silent.site_id AND st.stage = 'code_import'
          RETURNING st.site_id::text AS site_id, s.workspace_id::text AS workspace_id,
                    st.attempt, st.enqueues, st.lease_epoch`,
      )
      for (const stage of requeued)
        await enqueueSiteProvisioningStage(tx, {
          siteId: stage.site_id,
          stage: STAGE,
          attempt: stage.attempt,
          enqueues: stage.enqueues,
        })
      const interrupted = z.array(sweptRowSchema).parse(
        await tx.$queryRaw`
          WITH silent AS (
            SELECT site_id FROM site_provisioning_stages
            WHERE finished_at IS NULL AND stage = 'code_import' AND status = 'running'
              AND enqueues >= ${provisioningLimits.enqueuesPerAttempt}::int
              AND heartbeat_at < now() - ${silence}::int * interval '1 millisecond'
            ORDER BY heartbeat_at
            LIMIT ${SWEEP_BATCH}::int
            FOR UPDATE SKIP LOCKED
          )
          UPDATE site_provisioning_stages st
          SET status = 'failed', error_code = 'interrupted', finished_at = now(), step = NULL,
              heartbeat_at = NULL, updated_at = now()
          FROM silent JOIN sites s ON s.id = silent.site_id
          WHERE st.site_id = silent.site_id AND st.stage = 'code_import'
          RETURNING st.site_id::text AS site_id, s.workspace_id::text AS workspace_id,
                    st.attempt, st.enqueues, st.lease_epoch`,
      )
      const swept = (row: z.infer<typeof sweptRowSchema>): SweptStage => ({
        siteId: row.site_id,
        workspaceId: row.workspace_id,
        attempt: row.attempt,
        enqueues: row.enqueues,
        leaseEpoch: row.lease_epoch,
      })
      return { requeued: requeued.map(swept), interrupted: interrupted.map(swept) }
    })
  }

  async waiting(): Promise<{ siteId: string; attempt: number }[]> {
    const rows = await this.#prisma.$queryRaw<{ site_id: string; attempt: number }[]>`
      SELECT site_id::text AS site_id, attempt FROM site_provisioning_stages
      WHERE finished_at IS NULL AND stage = 'code_import' AND status = 'queued'
        AND updated_at < now() - ${provisioningLimits.queuedStaleMs}::int * interval '1 millisecond'
      ORDER BY updated_at
      LIMIT ${SWEEP_BATCH}::int`
    return rows.map((row) => ({ siteId: row.site_id, attempt: row.attempt }))
  }
}
