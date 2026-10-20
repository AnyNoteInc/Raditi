import { createHash, timingSafeEqual } from 'node:crypto'

import {
  recordReleaseStep,
  releaseAttemptWrote,
  releaseWritingAttempt,
  renewReleaseLease,
  wakeRelease,
  type PrismaClient,
} from '@repo/db'
import {
  badRequest,
  conflict,
  dbPlanLimits,
  deployAccessSchema,
  deployManifestSchema,
  DomainError,
  ftpAccessSchema,
  isDomainError,
  MAX_PRESIGN_TTL_MS,
  notFound,
  releaseApiLimits,
  releaseBackupRequestSchema,
  releaseStatusAfterStep,
  releaseStepReportSchema,
  siteAccessPath,
  sshAccessSchema,
  writingReleaseSteps,
  type DeployAccess,
  type DeployManifest,
  type ObjectStorage,
  type PresignedRequest,
  type ReleaseBackupAnswer,
  type ReleasePresigned,
  type ReleaseStatus,
  type ReleaseStepAnswer,
  type SecretStore,
  type SiteAccessKind,
  type SiteAdapter,
  type SiteContentAdapter,
  type SiteStack,
  verifyRecordPageSchema,
} from '@repo/domain'
import { z } from 'zod'

import type { ReleaseGit } from '../git-workspace/release-git.ts'
import { moveTaskDuringRelease } from '../releases/release-outcome.ts'
import {
  backupObject,
  dbValueObject,
  DEPLOY_SILENCE_MS,
  deployPlanOf,
  hostingAccessKind,
  installedBaseOf,
  readReleaseRow,
  releaseErrorOfReport,
  releaseValuePath,
  siteRepository,
  UNKNOWN_GRACE_MS,
  type ReleaseRow,
} from '../releases/release-row.ts'

// The release API of core (docs/plan/53-chat-preview-release.md, Р29, Р30, Р32, «Маршруты»):
// what the `deploy-step` command of a deploy job gets and reports, the job having no database,
// Redis or S3 of its own. Every call carries the API token of its deploy attempt (Bearer), whose
// SHA-256 the release keeps; a release that does not hold the barrier of its site is answered
// with a conflict, whatever the token.

export const unauthorized = (): DomainError =>
  new DomainError('UNAUTHORIZED', 'Release API token is not valid', 401)

/**
 * Where the job still talks to core: from the tag (the skill may not have written `published`
 * yet) to the end of its rollback; `unknown` while the job may still report the rollback of a
 * write it could not prove.
 */
const servingStatuses: readonly ReleaseStatus[] = [
  'publishing',
  'published',
  'deploying',
  'verifying',
  'rolling_back',
  'unknown',
]
/** The statuses a job goes on in: every other answer tells it to stop (and roll back). */
const goingOn: readonly ReleaseStatus[] = ['deploying', 'verifying', 'rolling_back']
const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/

const sha256 = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex')

const sameHash = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

const presigned = (request: PresignedRequest): ReleasePresigned => ({
  method: request.method,
  url: request.url,
  headers: request.headers,
  expiresAt: request.expiresAt.toISOString(),
})

const accessRequestSchema = z.strictObject({ deployAttempt: z.number().int().min(1).optional() })

export interface ReleaseApiDependencies {
  db: PrismaClient
  /** null without git: no manifest can be built. */
  git: Pick<ReleaseGit, 'changeDigests'> | null
  secrets: Pick<SecretStore, 'kvRead'>
  storage: Pick<ObjectStorage, 'presign' | 'get' | 'delete'>
  adapter: (stack: SiteStack) => Pick<SiteAdapter, 'verify' | 'mediaRules'>
  contentAdapter: (stack: SiteStack) => Pick<SiteContentAdapter, 'accessKind'>
  /**
   * RELEASE_API_PUBLIC_URL: the origin deploy jobs call. The manifest names the values of the
   * database plan by it (`…/values/<index>`).
   */
  publicUrl: string
}

/** A sealed value is at most this large: the plaintext limit twice, and the envelope. */
const VALUE_MAX_BYTES = dbPlanLimits.valueBytes * 2 + 1024

/** What a report is answered with, and its HTTP status: 409 when it is refused. */
export interface StepAnswer {
  status: 200 | 409
  answer: ReleaseStepAnswer
}

export class ReleaseApi {
  constructor(private readonly deps: ReleaseApiDependencies) {}

  /**
   * The release of a valid token: its hash is the one of the attempt, it has not expired, and
   * the release holds the barrier of its site. Anything else is the same 401 or 409.
   */
  async #authenticate(releaseId: string, authorization: string | undefined): Promise<ReleaseRow> {
    const token = TOKEN.exec(authorization ?? '')?.[1]
    if (!token || !z.uuid().safeParse(releaseId).success) throw unauthorized()
    const checks = z
      .array(
        z.object({
          hash: z.string().nullable(),
          live: z.boolean().nullable(),
          barrier: z.boolean().nullable(),
        }),
      )
      .parse(
        await this.deps.db.$queryRaw`
          SELECT r.deploy_token_hash AS hash,
            r.deploy_token_expires_at > clock_timestamp() AS live,
            l.inflight_release_id = r.id AS barrier
          FROM site_releases r LEFT JOIN site_leases l ON l.site_id = r.site_id
          WHERE r.id = ${releaseId}::uuid`,
      )[0]
    if (!checks?.hash || !sameHash(sha256(token), checks.hash) || checks.live !== true)
      throw unauthorized()
    if (checks.barrier !== true) throw conflict('The release does not hold its site')
    const row = await readReleaseRow(this.deps.db, releaseId)
    if (!row || !servingStatuses.includes(row.status)) throw conflict('The release is over')
    return row
  }

  /**
   * `GET …/manifest` (Р30): what the job checks, backs up and writes — every path the release
   * changes between what the hosting holds and the release commit, with the SHA-256 of both
   * sides, the database plan with the request of each value core sealed for the attempt
   * (`…/values/<index>` of this API), the fence of the content writes and the pages of the check.
   */
  async manifest(releaseId: string, authorization: string | undefined): Promise<DeployManifest> {
    const row = await this.#authenticate(releaseId, authorization)
    const { git } = this.deps
    const repository = await siteRepository(this.deps.db, row.siteId)
    const method = await this.#method(row.siteId)
    if (!git || !repository || row.approvedSha === null || row.deployAttempt === 0)
      throw conflict('The release has no commit')
    const changes = await git.changeDigests({
      repo: repository.repo,
      baseSha: installedBaseOf(row),
      headSha: row.approvedSha,
    })
    // An attempt «только возврат» (Р31) restores what the attempt that wrote left, from its
    // backup; its values are that attempt's, sealed with the key its wrapping holds again.
    const writing = await this.#rollbackOf(row)
    const manifest = deployManifestSchema.safeParse({
      v: 1,
      // An undo writes what production held before the release it undoes (`restore`).
      kind: row.kind,
      releaseId: row.id,
      siteId: row.siteId,
      deployAttempt: row.deployAttempt,
      tag: row.tag,
      installedSha: row.installedBeforeSha,
      approvedSha: row.approvedSha,
      method,
      files: {
        write: changes
          .filter((change) => change.change !== 'deleted')
          .map((change) => ({
            path: change.path,
            before: change.before,
            after: change.after,
            sizeBytes: change.sizeBytes,
            executable: change.executable,
          })),
        delete: changes
          .filter((change) => change.change === 'deleted')
          .map((change) => ({ path: change.path, before: change.before })),
      },
      db: this.#plan(row, authorization ?? ''),
      contentEpoch: row.leaseEpoch,
      rollbackOf:
        writing === null
          ? null
          : {
              deployAttempt: writing,
              backup: presigned(
                await this.deps.storage.presign({
                  bucket: 'backups',
                  key: backupObject(row.siteId, row.id, writing),
                  method: 'GET',
                  ttlMs: MAX_PRESIGN_TTL_MS,
                }),
              ),
              sha256: row.backupSha256,
              sizeBytes: row.backupBytes === null ? null : Number(row.backupBytes),
            },
      addOnlyPaths: this.#addOnlyPaths(row),
      verify: this.#verifyPlan(row),
    })
    if (!manifest.success) throw conflict('The release cannot be described to its job')
    return manifest.data
  }

  /**
   * The attempt whose writes this one only restores, when it is an attempt «только возврат»:
   * a later attempt than the last one that wrote (`releaseWritingAttempt`); null — a regular one.
   */
  async #rollbackOf(row: ReleaseRow): Promise<number | null> {
    const writing = await releaseWritingAttempt(this.deps.db, { releaseId: row.id })
    return writing !== null && row.deployAttempt > writing ? writing : null
  }

  async #method(siteId: string): Promise<'sftp' | 'ftp'> {
    const source = await this.deps.db.siteCodeSource.findUnique({
      where: { siteId },
      select: { kind: true },
    })
    if (source?.kind !== 'sftp' && source?.kind !== 'ftp')
      throw conflict('The code of the site is not on a hosting a release writes to')
    return source.kind
  }

  /**
   * `SiteAdapter.mediaRules().addOnlyPaths` (Р12, R8c): folders where the release only adds
   * files — the job refuses a manifest that replaces or deletes one there. A stack that does not
   * say yet has none.
   */
  #addOnlyPaths(row: ReleaseRow): string[] {
    const site = { stack: row.site.stack, url: row.site.url, docroot: '/', extras: {} }
    try {
      return [...this.deps.adapter(row.site.stack).mediaRules(site).addOnlyPaths]
    } catch (error) {
      if (!isDomainError(error) || error.code !== 'NOT_IMPLEMENTED') throw error
      return []
    }
  }

  /**
   * `SiteAdapter.verify()` against the origin of the site's address: its pages and failure
   * markers; a stack that does not say yet is checked by its home page.
   */
  #verifyPlan(row: ReleaseRow): DeployManifest['verify'] {
    const origin = new URL(row.site.url).origin
    try {
      const plan = this.deps
        .adapter(row.site.stack)
        .verify({ stack: row.site.stack, url: row.site.url, docroot: '/', extras: {} })
      const pages = plan.pages.filter(
        (page) => /^\/[\x21-\x7e]*$/.test(page) && page.length <= 1024,
      )
      const failureMarkers = plan.failureMarkers.filter(
        (marker) => marker.length >= 4 && marker.length <= 200,
      )
      // The pages of the records a release creates, those the manifest takes.
      const recordPages = Object.fromEntries(
        Object.entries(plan.recordPages ?? {})
          .filter(
            ([type, page]) =>
              /^[a-z][a-z_]{0,31}$/.test(type) && verifyRecordPageSchema.safeParse(page).success,
          )
          .slice(0, 8),
      )
      return {
        origin,
        failureMarkers: failureMarkers.slice(0, 32),
        pages: pages.length > 0 ? pages.slice(0, releaseApiLimits.verifyPages) : ['/'],
        ...(Object.keys(recordPages).length > 0 ? { recordPages } : {}),
      }
    } catch (error) {
      if (!isDomainError(error) || error.code !== 'NOT_IMPLEMENTED') throw error
      return { origin, failureMarkers: [], pages: ['/'] }
    }
  }

  /**
   * The operations of the candidate's plan, each with the request of its value: a GET of this
   * API (`…/values/<index>`) with the token the manifest was asked with — the job's own. Served
   * on demand from what the skill sealed for the attempt, so the request does not expire while
   * the job reads the hosting first (a presigned GET of S3 would, in MAX_PRESIGN_TTL_MS); it
   * lives as long as the token.
   */
  #plan(row: ReleaseRow, authorization: string): DeployManifest['db'] {
    // Every kind the readiness let through, in the plan's one order (an undo's: the reverse of
    // the release it undoes): the job writes them so.
    const plan = deployPlanOf(row)
    const expiresAt = (row.deployTokenExpiresAt ?? new Date()).toISOString()
    return plan.map((operation, index) => ({
      operation,
      after: {
        method: 'GET',
        url: `${this.deps.publicUrl}${releaseValuePath(row.id, index)}`,
        headers: { authorization },
        expiresAt,
      },
    }))
  }

  /**
   * `GET …/values/<index>` (Р30): the value of one operation of the plan as the skill sealed it
   * for the attempt — for an attempt «только возврат», for the attempt it restores — read from
   * `raditi-backups` on each call. Sealed with the key of the job's wrapping: core serves bytes
   * it cannot be asked to open.
   */
  async value(
    releaseId: string,
    authorization: string | undefined,
    index: string,
  ): Promise<Buffer> {
    const row = await this.#authenticate(releaseId, authorization)
    const plan = deployPlanOf(row)
    const at = /^\d{1,4}$/.test(index) ? Number(index) : -1
    if (at < 0 || at >= plan.length || row.deployAttempt === 0)
      throw notFound('The plan has no such operation')
    const attempt = (await this.#rollbackOf(row)) ?? row.deployAttempt
    const object = await this.deps.storage.get(
      'backups',
      dbValueObject(row.siteId, row.id, attempt, at),
    )
    if (!object) throw conflict('The value of the operation is missing')
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of object) {
      bytes += chunk.byteLength
      if (bytes > VALUE_MAX_BYTES) throw conflict('The value of the operation is too large')
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  /**
   * `POST …/access` (Р29): the hosting and the content plugin as Vault keeps them, to one
   * attempt and only after the job reported its start. Read before the attempt is marked, so a
   * failed read can be asked again; never logged. The same attempt may ask again until it reports
   * past its start (`conflicts succeeded`, or anything after `rollback started` of an attempt
   * «только возврат»): an answer lost on the way is not the end of the attempt (R8c). After that
   * the access is not given again.
   */
  async access(
    releaseId: string,
    authorization: string | undefined,
    body: unknown = {},
  ): Promise<DeployAccess> {
    const row = await this.#authenticate(releaseId, authorization)
    const request = accessRequestSchema.safeParse(body)
    if (!request.success) throw badRequest('Invalid access request')
    // After the first report: `conflicts started`, or `rollback started` of an attempt «только
    // возврат».
    const rollbackOnly = row.status === 'rolling_back' && (await this.#rollbackOf(row)) !== null
    const started = row.status === 'deploying' || rollbackOnly
    if (
      !started ||
      (request.data.deployAttempt !== undefined && request.data.deployAttempt !== row.deployAttempt)
    )
      throw conflict('Access is given once, after the start of the attempt')
    // The first report of the attempt: the only one it may have sent when it asks again.
    const first = rollbackOnly ? 'rollback' : 'conflicts'
    // A client who paused, disconnected or archived the site took it away from the platform: a
    // job that has not got its access yet gets none.
    const site = await this.deps.db.site.findUnique({
      where: { id: row.siteId },
      select: { status: true },
    })
    if (site?.status !== 'active') throw conflict('The site is not active')
    const method = await this.#method(row.siteId)
    const stored = await this.#secret(row.siteId, hostingAccessKind(method)!)
    if (stored === null) throw conflict('The site has no access to its hosting')
    const hosting =
      method === 'sftp'
        ? { method, access: sshAccessSchema.parse(stored) }
        : { method, access: ftpAccessSchema.parse(stored) }
    let content: DeployAccess['content'] = null
    let contentKind: SiteAccessKind | null = null
    // The plugin's access to every job: it writes and restores the records of the plan, and it
    // drops the code a job wrote from the code cache of the site's PHP before the site is
    // checked (stand R12). It gives the job nothing its access to the hosting does not: that one
    // writes every file of the site, its configuration included.
    try {
      contentKind = this.deps.contentAdapter(row.site.stack).accessKind
    } catch (error) {
      if (!isDomainError(error) || error.code !== 'NOT_IMPLEMENTED') throw error
    }
    if (contentKind !== null) {
      const access = await this.#secret(row.siteId, contentKind)
      if (access !== null) content = { stack: row.site.stack, access }
    }
    const parsed = deployAccessSchema.safeParse({ v: 1, hosting, content })
    if (!parsed.success) throw conflict('The access of the site is not usable')
    const issued = await this.deps.db.$queryRaw<Array<{ id: string }>>`
      UPDATE site_releases r SET access_issued_at = COALESCE(r.access_issued_at, clock_timestamp()),
        deploy_token_expires_at = clock_timestamp() + ${DEPLOY_SILENCE_MS}::int * interval '1 millisecond',
        updated_at = clock_timestamp()
      WHERE r.id = ${row.id}::uuid AND r.status = ${row.status}::"ReleaseStatus"
        AND r.deploy_attempt = ${row.deployAttempt} AND r.deploy_token_hash IS NOT NULL
        AND (r.access_issued_at IS NULL OR NOT EXISTS (
          SELECT 1 FROM release_steps s
          WHERE s.release_id = r.id AND s.deploy_attempt = r.deploy_attempt
            AND NOT (s.step = ${first} AND s.state = 'started')))
      RETURNING r.id`
    if (issued.length === 0) throw conflict('Access is given once, after the start of the attempt')
    return parsed.data
  }

  /**
   * One access of the site from Vault, by its one reference (`credential_refs`): the reference
   * must name the only path of that access, and the secret is read at the version the reference
   * names — a newer one a request of the connection wizard wrote before it failed to move the
   * reference does not stand in for it (plan 39). null — the site has no access of this kind.
   */
  async #secret(siteId: string, kind: SiteAccessKind): Promise<Record<string, string> | null> {
    const refs = await this.deps.db.credentialRef.findMany({
      where: { siteId, kind },
      select: { vaultPath: true, keyVersion: true },
      take: 2,
    })
    if (refs.length === 0) return null
    const ref = refs.length === 1 ? refs[0]! : null
    if (!ref || ref.vaultPath !== siteAccessPath(siteId, kind))
      throw conflict('The access of the site has no single reference')
    const stored = await this.deps.secrets.kvRead(ref.vaultPath, { version: ref.keyVersion })
    if (!stored || stored.version !== ref.keyVersion)
      throw conflict('The access of the site is not the one referenced')
    return stored.data
  }

  /**
   * `POST …/steps` (Р30, Р31): a report of the job, once per key. A new report moves the
   * release by its state machine (`releaseStatusAfterStep`), keeps the lease and the token
   * alive and wakes the skill; a repeated one (the job's heartbeat) keeps them alive too while
   * the release goes on, and gets the answer of the release as it is. A step
   * the release does not take, or a write before the backup was verified, is refused (409) and
   * not kept.
   */
  async step(
    releaseId: string,
    authorization: string | undefined,
    body: unknown,
  ): Promise<StepAnswer> {
    const row = await this.#authenticate(releaseId, authorization)
    const parsed = releaseStepReportSchema.safeParse(body)
    if (!parsed.success) throw badRequest('Invalid step report')
    const report = parsed.data
    if (report.deployAttempt !== row.deployAttempt) return refused()
    return this.deps.db
      .$transaction(async (tx) => {
        const locked = z
          .array(
            z.object({
              status: z.string(),
              deploy_attempt: z.number(),
              backup_verified: z.boolean(),
              published: z.boolean(),
            }),
          )
          .parse(
            await tx.$queryRaw`
              SELECT status::text AS status, deploy_attempt,
                backup_verified_at IS NOT NULL AS backup_verified,
                (main_pushed_at IS NOT NULL AND deploy_token_hash IS NOT NULL) AS published
              FROM site_releases WHERE id = ${row.id}::uuid FOR UPDATE`,
          )[0]
        if (!locked || locked.deploy_attempt !== report.deployAttempt) return refused()
        let status = locked.status as ReleaseStatus
        const inserted = await recordReleaseStep(tx, { releaseId: row.id, ...report })
        if (!inserted) {
          // A repeat is the job's heartbeat (R8c: `started` of its step again after a minute
          // without a report): while it goes on, the token and the lease live on as after a new
          // report; the status does not move.
          if (goingOn.includes(status)) {
            await tx.$queryRaw`
              UPDATE site_releases SET deploy_token_expires_at = GREATEST(deploy_token_expires_at,
                  clock_timestamp() + ${DEPLOY_SILENCE_MS}::int * interval '1 millisecond'),
                updated_at = clock_timestamp()
              WHERE id = ${row.id}::uuid AND deploy_token_hash IS NOT NULL
              RETURNING id`
            await renewReleaseLease(tx, { releaseId: row.id, ttlMs: DEPLOY_SILENCE_MS })
          }
          return answer(status)
        }
        // The tag starts the run (Р29): its first report may come before the skill wrote
        // `published`. The token of the armed attempt proves the tag names the release commit.
        if (
          status === 'publishing' &&
          locked.published &&
          report.step === 'conflicts' &&
          report.state === 'started'
        ) {
          await tx.$queryRaw`
            UPDATE site_releases SET status = 'published', updated_at = clock_timestamp()
            WHERE id = ${row.id}::uuid AND status = 'publishing'
            RETURNING id`
          status = 'published'
        }
        if (
          report.state === 'started' &&
          (writingReleaseSteps as readonly string[]).includes(report.step) &&
          !locked.backup_verified
        )
          throw new StepRefused()
        const wrote = await releaseAttemptWrote(tx, {
          releaseId: row.id,
          deployAttempt: report.deployAttempt,
        })
        let next: ReleaseStatus | null
        try {
          next = releaseStatusAfterStep(status, report.step, report.state, wrote)
        } catch (error) {
          if (isDomainError(error) && error.code === 'CONFLICT') throw new StepRefused()
          throw error
        }
        const after = next ?? status
        // A write the job cannot prove: it restores what it wrote right after, and that
        // rollback may still be reported (Р31). An undo whose site failed its check before and
        // after the write — or after the rollback of a write that failed — restores nothing more
        // (`site_broken_both`): the operator decides at once.
        const grace =
          after === 'unknown' &&
          report.step !== 'rollback' &&
          report.step !== 'reverify' &&
          report.detail.code !== 'site_broken_both'
        const live = goingOn.includes(after) || grace
        const ttlMs = grace ? UNKNOWN_GRACE_MS : DEPLOY_SILENCE_MS
        const error = next === null ? null : releaseErrorOfReport(report)
        // The first error stays, but a site that failed its check before an undo and after its
        // rollback says what the operator decides on (`site_broken_both`): no attempt «только
        // возврат» follows it.
        await tx.$queryRaw`
          UPDATE site_releases SET status = ${after}::"ReleaseStatus", step = ${report.step},
            error_code = CASE WHEN ${error}::varchar = 'site_broken_both' THEN ${error}::varchar
              ELSE COALESCE(error_code, ${error}::varchar) END,
            deploy_token_hash = CASE WHEN ${live} THEN deploy_token_hash END,
            deploy_token_expires_at = CASE WHEN ${live}
              THEN clock_timestamp() + ${ttlMs}::int * interval '1 millisecond' END,
            updated_at = clock_timestamp()
          WHERE id = ${row.id}::uuid
          RETURNING id`
        if (next === 'deploying' && row.deploymentId !== null)
          await tx.deployment.updateMany({
            where: { id: row.deploymentId, status: 'pending' },
            data: { status: 'running', startedAt: new Date() },
          })
        // An undo leaves its dialog — closed with the release it undoes — where it is.
        if (next !== null && row.kind === 'release')
          await moveTaskDuringRelease(tx, row.taskId, next)
        if (live) await renewReleaseLease(tx, { releaseId: row.id, ttlMs })
        if (next !== null) await wakeRelease(tx, { releaseId: row.id })
        return answer(after)
      })
      .catch((error: unknown) => {
        if (error instanceof StepRefused) return refused()
        throw error
      })
  }

  /**
   * `POST …/backup` (Р30): `put` — a presigned, create-only PUT of the encrypted backup of the
   * attempt, of exactly the size the job names; `verify` — core reads what landed there and
   * compares its size and SHA-256 with what the job named. A mismatch is deleted, so the job may
   * upload again; only a verified backup lets a writing step start.
   */
  async backup(
    releaseId: string,
    authorization: string | undefined,
    body: unknown,
  ): Promise<ReleaseBackupAnswer> {
    const row = await this.#authenticate(releaseId, authorization)
    const parsed = releaseBackupRequestSchema.safeParse(body)
    if (!parsed.success) throw badRequest('Invalid backup request')
    const request = parsed.data
    if (row.status !== 'deploying' || request.deployAttempt !== row.deployAttempt)
      throw conflict('A backup belongs to a started attempt before its writes')
    const key = backupObject(row.siteId, row.id, row.deployAttempt)
    if (request.phase === 'put') {
      const named = await this.deps.db.$queryRaw<Array<{ id: string }>>`
        UPDATE site_releases SET backup_object_key = ${key}, backup_sha256 = ${request.sha256},
          backup_bytes = ${request.sizeBytes},
          deploy_token_expires_at = clock_timestamp() + ${DEPLOY_SILENCE_MS}::int * interval '1 millisecond',
          updated_at = clock_timestamp()
        WHERE id = ${row.id}::uuid AND status = 'deploying'
          AND deploy_attempt = ${row.deployAttempt} AND backup_verified_at IS NULL
          AND deploy_token_hash IS NOT NULL
        RETURNING id`
      if (named.length === 0) throw conflict('The backup of the attempt is verified already')
      const put = await this.deps.storage.presign({
        bucket: 'backups',
        key,
        method: 'PUT',
        sizeBytes: request.sizeBytes,
        ttlMs: MAX_PRESIGN_TTL_MS,
      })
      return { phase: 'put', put: presigned(put) }
    }
    // Only what the job named for its upload is verified, and only once.
    if (
      row.backupObjectKey !== key ||
      row.backupSha256 !== request.sha256 ||
      row.backupBytes !== BigInt(request.sizeBytes)
    )
      return { phase: 'verify', verified: false }
    if (row.backupVerifiedAt !== null) return { phase: 'verify', verified: true }
    const landed = await this.#measure(key, request.sizeBytes)
    const verified = landed?.sha256 === request.sha256 && landed.bytes === request.sizeBytes
    if (!verified) {
      if (landed) await this.deps.storage.delete('backups', key)
      return { phase: 'verify', verified: false }
    }
    const marked = await this.deps.db.$queryRaw<Array<{ id: string }>>`
      UPDATE site_releases SET backup_verified_at = clock_timestamp(),
        deploy_token_expires_at = clock_timestamp() + ${DEPLOY_SILENCE_MS}::int * interval '1 millisecond',
        updated_at = clock_timestamp()
      WHERE id = ${row.id}::uuid AND status = 'deploying' AND deploy_attempt = ${row.deployAttempt}
        AND backup_object_key = ${key} AND backup_sha256 = ${request.sha256}
        AND deploy_token_hash IS NOT NULL
      RETURNING id`
    if (marked.length === 0) return { phase: 'verify', verified: false }
    await renewReleaseLease(this.deps.db, { releaseId: row.id, ttlMs: DEPLOY_SILENCE_MS })
    return { phase: 'verify', verified: true }
  }

  /** Size and SHA-256 of an object, read to its end; null when it is absent. */
  async #measure(key: string, limit: number): Promise<{ bytes: number; sha256: string } | null> {
    const object = await this.deps.storage.get('backups', key)
    if (!object) return null
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of object) {
      bytes += chunk.byteLength
      // Past the size named: it cannot match, and nothing more is read.
      if (bytes > limit) return { bytes, sha256: '' }
      hash.update(chunk)
    }
    return { bytes, sha256: hash.digest('hex') }
  }
}

/** Thrown inside the transaction of a report to roll it back: the report is not kept. */
class StepRefused extends Error {}

const refused = (): StepAnswer => ({ status: 409, answer: { accepted: false, proceed: false } })
const answer = (status: ReleaseStatus): StepAnswer => ({
  status: 200,
  answer: { accepted: true, proceed: goingOn.includes(status) },
})
