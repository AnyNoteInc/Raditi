import { z } from 'zod'

import { addOnlyPathSchema, isPublicationPath, publicationShaSchema } from '../git/publication.ts'
import { publishedContentPatchSchema } from '../ports/published-content.ts'
import { siteStacks } from '../ports/site-adapter.ts'
import { dbCreatedRecordSchema } from '../ports/site-db.ts'
import { ftpAccessSchema, sshAccessSchema } from '../site-connection/access.ts'
import { dbSlugSchema, tableDefinitionSchema } from './db-objects.ts'
import { dbPlanLimits, deployDbOperationSchema, type DeployDbOperationKind } from './db-plan.ts'
import { releaseKinds, releaseSteps, releaseStepStates, type ReleaseKind } from './release-state.ts'
import { versionTagSchema } from './semver.ts'

/**
 * The contract between the release API of core and the `deploy-step` command of the deploy job
 * (docs/plan/53-chat-preview-release.md, Р29, Р30, Р32): the secret the job starts from, the
 * manifest it reads, the access it gets once, the reports of its steps and its backup. The
 * command has no database, Redis or S3: everything comes through these four calls.
 */

/** `environments.deploy_method`. `sftp` and `ftp` are how a release writes to a hosting. */
export const deployMethods = ['rsync', 'git_ftp', 'docker', 'sftp', 'ftp'] as const
export type DeployMethod = (typeof deployMethods)[number]

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const path = z
  .string()
  .min(1)
  .max(1024)
  .refine(isPublicationPath, 'expected a relative path of the site tree')
const httpsOrLocalUrl = z.url({ protocol: /^https?$/ }).max(4096)

/** The type of a record as a reference names it (`page:42` → `page`). */
const recordPageTypePattern = /^[a-z][a-z_]{0,31}$/
const RECORD_PAGE_ID = '{id}'
/** A path below the origin with `{id}` once: where a published record is served. */
export const verifyRecordPageSchema = z
  .string()
  .regex(/^\/[\x21-\x7e]*$/)
  .max(1024)
  .refine((page) => page.split(RECORD_PAGE_ID).length === 2, 'expected {id} once')

/**
 * The page of a record the release created, by the path of its type and its number on
 * production (`page:900` → `/?page_id=900`); null — its type has no page.
 */
export function createdRecordPage(
  recordPages: Readonly<Record<string, string>>,
  productionRef: string,
): string | null {
  const at = productionRef.indexOf(':')
  const id = productionRef.slice(at + 1)
  if (at < 1 || !/^[1-9]\d{0,18}$/.test(id)) return null
  const page = Object.hasOwn(recordPages, productionRef.slice(0, at))
    ? recordPages[productionRef.slice(0, at)]
    : undefined
  return page === undefined ? null : page.replace(RECORD_PAGE_ID, id)
}

// ---------------------------------------------------------------------------------------------
// The secret of the repository: RADITI_DEPLOY_WRAP
// ---------------------------------------------------------------------------------------------

/** A secret of the site's repository, never of the organization (Р29). */
export const DEPLOY_WRAP_SECRET_NAME = 'RADITI_DEPLOY_WRAP'

const WRAP =
  /^([0-9a-f-]{36}):([1-9]\d{0,5}):(v\d{1,9}\.\d{1,9}\.\d{1,9}):([0-9a-f]{40}):([A-Za-z0-9._-]{8,512})$/

export const deployWrapSchema = z.strictObject({
  releaseId: z.uuid(),
  /** `site_releases.deploy_attempt`. */
  attempt: z.number().int().min(1).max(999_999),
  tag: versionTagSchema,
  sha: publicationShaSchema,
  /** A Vault wrapping token: single use, 30 minutes. */
  wrapToken: z.string().regex(/^[A-Za-z0-9._-]{8,512}$/),
})
export type DeployWrap = z.infer<typeof deployWrapSchema>

/** `<releaseId>:<attempt>:<tag>:<sha>:<wrapToken>`. */
export const formatDeployWrap = (wrap: DeployWrap): string => {
  const value = deployWrapSchema.parse(wrap)
  return `${value.releaseId}:${value.attempt}:${value.tag}:${value.sha}:${value.wrapToken}`
}

export function parseDeployWrap(text: string): DeployWrap | null {
  const match = WRAP.exec(text)
  if (!match) return null
  const parsed = deployWrapSchema.safeParse({
    releaseId: match[1],
    attempt: Number(match[2]),
    tag: match[3],
    sha: match[4],
    wrapToken: match[5],
  })
  return parsed.success ? parsed.data : null
}

/**
 * Checked before the token is unwrapped: the run is of this tag and this commit. A mismatch
 * ends the job without spending the wrapping (a tag of the import, any other tag, a repeat).
 */
export const deployWrapMatchesRun = (
  wrap: DeployWrap,
  run: { refName: string; sha: string },
): boolean => wrap.tag === run.refName && wrap.sha === run.sha

/** The lifetime of the wrapping (`SecretStore.wrap`, Р29): 30 minutes. */
export const DEPLOY_WRAP_TTL_SECONDS = 30 * 60

/**
 * What the wrapping holds (`SecretStore.wrap` data, strings only; core writes it in
 * `releases/release-skill.ts`, R8b, and the job reads it, R8c 17.10): the release and the deploy
 * attempt it is for — the job compares them with the secret before it calls anyone —,
 * `releaseApiToken`, the bearer token of the release API for this one attempt (32 random bytes,
 * base64url), and `backupKey`, the 32-byte data key (base64) of the attempt: the job seals its
 * backup with it and opens the values of the database operations with it. Transit `ws-<wsId>`
 * issues the key; core keeps only its ciphertext (`raditi-backups`, next to the backup). An
 * attempt «только возврат» (`manifest.rollbackOf`) gets the key of the attempt it rolls back.
 * Nothing else: the hosting and the plugin come from `POST …/access`, once.
 */
export const deployWrapDataSchema = z.strictObject({
  v: z.literal('1'),
  releaseId: z.uuid(),
  attempt: z.string().regex(/^[1-9]\d{0,5}$/),
  releaseApiToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  backupKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
})
export type DeployWrapData = z.infer<typeof deployWrapDataSchema>

/** The wrapping was made for the release and the attempt the secret names. */
export const deployWrapDataMatches = (data: DeployWrapData, wrap: DeployWrap): boolean =>
  data.releaseId.toLowerCase() === wrap.releaseId.toLowerCase() &&
  data.attempt === String(wrap.attempt)

/**
 * The envelope of everything sealed with `backupKey` (R8c 17.10): AES-256-GCM, a fresh 96-bit IV,
 * a 128-bit tag; bytes `RDE1` ‖ IV (12) ‖ tag (16) ‖ ciphertext. The associated data is not
 * stored — each side names it from what it already holds (`deployBackupAad`, `deployValueAad`),
 * so a backup of another attempt or the value of another object does not open. One code for both
 * sides: `sealDeployEnvelope` and `openDeployEnvelope` of
 * `apps/orchestrator/src/deploy-step/envelope.ts` (core seals the values with it, R8b; the job
 * seals and opens its backup and opens the values, R8c).
 */
export const DEPLOY_ENVELOPE_MAGIC = 'RDE1'

/**
 * The associated data of the backup of one attempt: the object `raditi-backups`
 * `…/<attempt>/backup.tar.zst.enc`, a zstd-compressed tar (its layout is in
 * `apps/orchestrator/src/deploy-step/backup.ts`). The job writes it; the job of an attempt
 * «только возврат» reads it; core checks only its size and SHA-256.
 */
export const deployBackupAad = (releaseId: string, deployAttempt: number): string =>
  `raditi-release-backup-v1|${releaseId.toLowerCase()}|${deployAttempt}`

/**
 * The associated data of the value a database operation writes (`manifest.db[].after`, an object
 * of `raditi-backups` the release API hands out on demand — R8b 17.10: a GET of
 * `…/values/<index>` with the attempt's token): the plaintext is the JSON of
 * `deployValueSchemas[kind]` — taken by core from the object's state after the agent's write into
 * the preview. An undo's values (docs/plan/53, «Отмена выпуска») — what production held before the
 * release — are written in the plugin's mode `restore`, so they are bound to the kind of the row
 * too: a value sealed for a release never opens as one of an undo.
 */
export const deployValueAad = (
  releaseId: string,
  objectRef: string,
  afterHash: string,
  kind: ReleaseKind = 'release',
): string =>
  `${kind === 'undo' ? 'raditi-undo-value-v1' : 'raditi-release-value-v1'}|${releaseId.toLowerCase()}|${objectRef}|${afterHash}`

const tableSide = z.strictObject({
  exists: z.boolean(),
  managed: z.boolean(),
  definition: tableDefinitionSchema.nullable(),
})

/**
 * The plaintext of the value of each kind of operation (docs/plan/53, «Операции БД и миграции»):
 * a text change — exactly the operation's fields; a setting — its value as the database keeps
 * it (null — no row: an undo of a release that added the setting); a new record — everything
 * production stores of it; a table — the state it is found in (said whole: the plugin finds where
 * a repeated write left it) and the definition it gets; the trash of a record an undo takes back
 * — its address and the mark of its creation (`createCallId`).
 */
export const deployValueSchemas = Object.freeze({
  content_update: z.strictObject({ v: z.literal(1), fields: publishedContentPatchSchema }),
  option_update: z.strictObject({
    v: z.literal(1),
    value: z
      .string()
      .max(dbPlanLimits.valueBytes)
      .refine((value) => !value.includes('\0'))
      .nullable(),
  }),
  post_create: z.strictObject({ v: z.literal(1), record: dbCreatedRecordSchema }),
  schema_migration: z.strictObject({
    v: z.literal(1),
    before: tableSide,
    definition: tableDefinitionSchema,
  }),
  post_trash: z.strictObject({ v: z.literal(1), slug: dbSlugSchema, createCallId: z.uuid() }),
} satisfies Record<DeployDbOperationKind, z.ZodType>)
export type DeployValue<Kind extends DeployDbOperationKind> = z.infer<
  (typeof deployValueSchemas)[Kind]
>

/** The kinds of the operations of an undo's manifest: values back, created records to the trash. */
const undoKinds: readonly DeployDbOperationKind[] = [
  'content_update',
  'option_update',
  'post_trash',
]

// ---------------------------------------------------------------------------------------------
// The release API (`RELEASE_API_PORT`)
// ---------------------------------------------------------------------------------------------

export const RELEASE_API_PREFIX = '/v1/releases'
export const releaseApiPaths = Object.freeze({
  manifest: (releaseId: string) => `${RELEASE_API_PREFIX}/${releaseId}/manifest`,
  access: (releaseId: string) => `${RELEASE_API_PREFIX}/${releaseId}/access`,
  steps: (releaseId: string) => `${RELEASE_API_PREFIX}/${releaseId}/steps`,
  backup: (releaseId: string) => `${RELEASE_API_PREFIX}/${releaseId}/backup`,
})
export const RELEASE_API_HEALTH_PATH = '/health'

export const releaseApiLimits = Object.freeze({
  bodyBytes: 64 * 1024,
  /** Files a release may write or delete. */
  files: 10_000,
  verifyPages: 20,
  /** A backup of the files and records a release overwrites. */
  backupBytes: 512 * 1024 * 1024,
})

/** A presigned request of the release API: method, URL and the headers it was signed with. */
export const releasePresignedSchema = z.strictObject({
  method: z.enum(['GET', 'PUT']),
  url: httpsOrLocalUrl,
  headers: z.record(z.string().max(128), z.string().max(4096)),
  expiresAt: z.iso.datetime(),
})
export type ReleasePresigned = z.infer<typeof releasePresignedSchema>

/** `GET …/manifest`: what the job writes, checks and backs up. */
export const deployManifestSchema = z
  .strictObject({
    v: z.literal(1),
    /**
     * `site_releases.kind` (docs/plan/53, «Отмена выпуска»): a release writes the values of its plan
     * in the plugin's mode `release`; an undo writes what production held before the release it
     * undoes in the mode `restore`, and goes on when the site already fails its check before the
     * write — the undo is what may mend it. Absent — a release.
     */
    kind: z.enum(releaseKinds).default('release'),
    releaseId: z.uuid(),
    siteId: z.uuid(),
    deployAttempt: z.number().int().min(1),
    tag: versionTagSchema,
    /** What the hosting holds now; null — nothing installed by the platform yet. */
    installedSha: publicationShaSchema.nullable(),
    approvedSha: publicationShaSchema,
    method: z.enum(deployMethods),
    files: z.strictObject({
      /**
       * The files `approvedSha` changes against what the hosting holds (`installedSha`), read by
       * the job from its own repository at `approvedSha`; `before` — what must be there now.
       * SHA-256 of the content on both sides (`GitWorkspaceService.changeDigests`).
       */
      write: z
        .array(
          z.strictObject({
            path,
            /** SHA-256 of the installed file; null — the path must not exist (an addition). */
            before: sha256.nullable(),
            after: sha256,
            sizeBytes: z.number().int().min(0),
            executable: z.boolean(),
          }),
        )
        .max(releaseApiLimits.files),
      delete: z.array(z.strictObject({ path, before: sha256 })).max(releaseApiLimits.files),
    }),
    db: z
      .array(
        z.strictObject({
          /**
           * A release's in the one order of a plan (`dbPlanOrder`), an undo's in the reverse of the
           * release it undoes: the job writes them as they come.
           */
          operation: deployDbOperationSchema,
          /**
           * The value to write, encrypted with the backup key; fetched without S3 credentials —
           * R8b (17.10): a GET of the release API (`…/values/<index>`) with the attempt's token in
           * `headers`, valid while the token lives, not a presigned GET of S3 that expires.
           */
          after: releasePresignedSchema,
        }),
      )
      .max(dbPlanLimits.operations),
    /**
     * The fence of the content writes (R8c 17.10): the epoch of the site lease `deploy` this
     * release holds (`site_releases.lease_epoch`). The plugin refuses a write of a lower epoch than
     * it has seen, so a write of an older lease can no longer land.
     */
    contentEpoch: z.number().int().min(1).max(2_147_483_647),
    /**
     * A «только возврат» attempt (Р31, R8c 17.10): the job restores what attempt
     * `rollbackOf.deployAttempt` left — files from that attempt's backup (a presigned GET of its
     * object, the size and SHA-256 core verified), records by inverse operations from the prior
     * states in it — and writes nothing new; the wrapping then holds that attempt's `backupKey`.
     * `files` and `db` are the lists of that attempt. Absent or null — a regular attempt.
     */
    rollbackOf: z
      .strictObject({
        deployAttempt: z.number().int().min(1),
        backup: releasePresignedSchema,
        sha256,
        sizeBytes: z.number().int().min(1).max(releaseApiLimits.backupBytes),
      })
      .nullable()
      .default(null),
    /**
     * `SiteAdapter.mediaRules().addOnlyPaths` (Р12; R8c 17.10): folders where a release only adds
     * files. The job refuses, before any write, a manifest that replaces or deletes a file under
     * one of them (`source_mismatch`). Absent — none.
     */
    addOnlyPaths: z.array(addOnlyPathSchema).max(8).default([]),
    /**
     * `SiteAdapter.verify()`: pages of the site that must end in a 2xx — directly or after at most
     * 3 redirects within the site (R8c 17.10) — before the first write and afterwards.
     */
    verify: z.strictObject({
      /** The origin of the site's address (`sites.url`): the pages are fetched there. */
      origin: httpsOrLocalUrl.refine(
        (value) => new URL(value).origin === value,
        'expected an origin',
      ),
      /** `VerifyPlan.failureMarkers`: text that, found in a page, means the site is broken. */
      failureMarkers: z.array(z.string().min(4).max(200)).max(32),
      pages: z
        .array(
          z
            .string()
            .regex(/^\/[\x21-\x7e]*$/)
            .max(1024),
        )
        .min(1)
        .max(releaseApiLimits.verifyPages),
      /**
       * `VerifyPlan.recordPages`: by the type of a record (`page`, `post`), the path of a
       * published one with `{id}` once for its number on production. The job checks there every
       * published record the release created, after its writes. Absent — none.
       */
      recordPages: z
        .record(z.string().regex(recordPageTypePattern), verifyRecordPageSchema)
        .refine((pages) => Object.keys(pages).length <= 8, 'at most 8 types of a record')
        .optional(),
    }),
  })
  .refine(
    (manifest) =>
      manifest.db.every(({ operation }) =>
        manifest.kind === 'undo'
          ? undoKinds.includes(operation.kind)
          : operation.kind !== 'post_trash',
      ),
    'the operations of the kind of the manifest',
  )
export type DeployManifest = z.infer<typeof deployManifestSchema>

/**
 * `POST …/access`: once per attempt, after the report `conflicts started` (Р29). The hosting
 * and the content plugin of the site as Vault keeps them; never logged, never written to disk.
 */
export const deployAccessSchema = z.strictObject({
  v: z.literal(1),
  hosting: z.discriminatedUnion('method', [
    z.strictObject({ method: z.literal('sftp'), access: sshAccessSchema }),
    z.strictObject({ method: z.literal('ftp'), access: ftpAccessSchema }),
  ]),
  /**
   * The secret of the site's content adapter (`SiteContentAdapter.accessSchema` of `stack` reads
   * it; R8c 17.10 — the stack names the adapter, the job never compares one); null — the site has
   * none, and a manifest with database operations is then refused.
   */
  content: z
    .strictObject({
      stack: z.enum(siteStacks),
      access: z.record(z.string().max(64), z.string().max(8192)),
    })
    .nullable(),
})
export type DeployAccess = z.infer<typeof deployAccessSchema>

// ---------------------------------------------------------------------------------------------
// Reports of the steps: POST …/steps
// ---------------------------------------------------------------------------------------------

/**
 * The codes `deploy-step` reports in `detail.code` (R8c 17.10); words for the operator and for the
 * texts of the dialog, never a message of a server.
 */
export const deployStepCodes = [
  /** A file or a record on production is not what the release expects: nothing was written. */
  'conflict',
  /** The hosting or the site's plugin did not answer, refused the access or broke a transfer. */
  'hosting_unavailable',
  'content_unavailable',
  /** The overwritten files are larger than `releaseApiLimits.backupBytes`. */
  'backup_too_large',
  /** core did not confirm the uploaded backup. */
  'backup_refused',
  /** A file of the approved commit or a value differs from what the manifest names. */
  'source_mismatch',
  /** A write was refused or its receipt did not match. */
  'write_failed',
  /** A page did not answer 2xx/3xx in time or showed a failure marker. */
  'site_broken',
  /**
   * The same check failed before the first write (R8c 17.10): the site was not answering as it
   * should before the release touched it, so nothing was written.
   */
  'site_broken_before',
  /**
   * The server of the site keeps its PHP code in a cache that does not look at the time of a
   * file (or looks too rarely), and the site's plugin cannot drop a file from it: no check of the
   * site after a write could tell the new code from the old one (stand R12). Before the first
   * write nothing was written; after it the rollback ends `unknown`.
   */
  'code_cache',
  /** The rollback found production changed by someone else after the write. */
  'changed_meanwhile',
  /**
   * An undo (docs/plan/53, «Отмена выпуска»): the site failed its check before the undo wrote —
   * it went on, since the version it undoes may be what broke the site — and fails it after the
   * write as well (`verify`), or after the rollback of a write that failed (`reverify`): going
   * back to that version mends nothing, the operator decides.
   */
  'site_broken_both',
  /**
   * The site's plugin cannot write a kind of the plan, or a setting of it (an older plugin, or a
   * user of the connection without the right): nothing was written.
   */
  'plugin_outdated',
  /** core answered `proceed: false`, or the job was cancelled. */
  'stopped',
] as const
export type DeployStepCode = (typeof deployStepCodes)[number]

/** Counts and a code only; never a path, a host or a message (rule 1). */
export const releaseStepDetailSchema = z.strictObject({
  files: z.number().int().min(0).optional(),
  objects: z.number().int().min(0).optional(),
  bytes: z.number().int().min(0).optional(),
  pages: z.number().int().min(0).optional(),
  /**
   * A rollback: created records it left because someone changed them after the release, and
   * tables whose structure stays (`schema_migration` has no inverse).
   */
  keptRecords: z.number().int().min(0).optional(),
  keptTables: z.number().int().min(0).optional(),
  /** `conflicts` of an undo: the site failed its check before anything was written. */
  brokenBefore: z.boolean().optional(),
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,47}$/)
    .optional(),
})
export type ReleaseStepDetail = z.infer<typeof releaseStepDetailSchema>

export const releaseReportKeySchema = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/)

/** The idempotency key of a report: `<deployAttempt>:<step>:<state>`; a repeat is the same row. */
export const releaseReportKey = (
  deployAttempt: number,
  step: (typeof releaseSteps)[number],
  state: (typeof releaseStepStates)[number],
): string => `${deployAttempt}:${step}:${state}`

export const releaseStepReportSchema = z
  .strictObject({
    reportKey: releaseReportKeySchema,
    deployAttempt: z.number().int().min(1),
    step: z.enum(releaseSteps),
    state: z.enum(releaseStepStates),
    detail: releaseStepDetailSchema,
  })
  .refine(
    (report) =>
      report.reportKey === releaseReportKey(report.deployAttempt, report.step, report.state),
    'reportKey must name the attempt, the step and the state',
  )
export type ReleaseStepReport = z.infer<typeof releaseStepReportSchema>

/** What core answers a report: go on, or stop (the barrier is no longer this release's). */
export const releaseStepAnswerSchema = z.strictObject({
  accepted: z.boolean(),
  /** false — the job must stop writing; with a write behind it, roll back. */
  proceed: z.boolean(),
})
export type ReleaseStepAnswer = z.infer<typeof releaseStepAnswerSchema>

// ---------------------------------------------------------------------------------------------
// The backup: POST …/backup
// ---------------------------------------------------------------------------------------------

const backupFacts = {
  deployAttempt: z.number().int().min(1),
  /** Of the encrypted archive. */
  sha256,
  sizeBytes: z.number().int().min(1).max(releaseApiLimits.backupBytes),
}

/** `put` asks where to upload; `verify` asks core to check what landed there. */
export const releaseBackupRequestSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('put'), ...backupFacts }),
  z.strictObject({ phase: z.literal('verify'), ...backupFacts }),
])
export type ReleaseBackupRequest = z.infer<typeof releaseBackupRequestSchema>

export const releaseBackupAnswerSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('put'), put: releasePresignedSchema }),
  /** false — the size or the SHA-256 differs: no write follows. */
  z.strictObject({ phase: z.literal('verify'), verified: z.boolean() }),
])
export type ReleaseBackupAnswer = z.infer<typeof releaseBackupAnswerSchema>
