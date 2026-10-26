import { profileNameSchema } from '@repo/auth'
import { lockUserRow, SiteStack, type Prisma } from '@repo/db'
import {
  codeSourceInputSchema,
  connectionCheckReasons,
  connectionTlsModes,
  databaseEngines,
  databaseInputSchema,
  siteConnectionLimits,
  siteSourceKinds,
  type CodeSourceTarget,
  type PreparedAccess,
} from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  codeSourceColumns,
  deadline,
  gatedChecks,
  logOrphanedSecrets,
  offersSource,
  requireSiteConnections,
  sourceRefusal,
  storeSiteAccess,
  type StoredAccess,
} from '../services/site-access.ts'
import {
  accessKindOf,
  changeSiteDatabase,
  changeSiteSource,
  readEditableAccess,
  unacceptedHostKey,
  type PinnedSource,
} from '../services/site-access-change.ts'
import { replaceAccessVariables } from '../services/site-access-variables.ts'
import {
  accessibleSite,
  assertConnectionsNotBusy,
  assertRoomForSiteSnapshot,
  assertSiteAccepted,
  assertStackConnectable,
  siteNotFound,
  siteOrigin,
  withHost,
} from '../services/site-basics.ts'
import {
  ACCESS_REPLACE_ACTION,
  assertRetryable,
  codeImportOnly,
  notFailed,
  readSiteSetup,
  requeueFailedImport,
  SETUP_RETRY_ACTION,
  setupOutput,
} from '../services/site-setup.ts'
import { consentedProcedure, router } from '../trpc.ts'

// The wizard «Добавить проект» and the screen «Настраиваем сайт» (docs/plan/39-site-connection-wizard.md),
// and «Переменные → Доступы» of a working site. Every procedure is a mutation except `setup` and
// `editableAccess`: an access travels in the body of a POST, never in the address of a GET. Creating the
// project is `project.create`; these check its steps beforehand, handle a failed first import afterwards
// and change an access of a site that works.

const reasonSchema = z.enum(connectionCheckReasons)

/** What a refused check of the files tells: the reason, and the folder or the key it saw. */
export const sourceRefusalFields = {
  reason: reasonSchema,
  suggestedRoot: z.string().optional(),
  hostKey: z.string().optional(),
}

/** What a check of the files answers: the key and the folder it saw, or why it failed. */
const sourceCheckOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), hostKey: z.string().nullable(), entries: z.number().nullable() }),
  z.object({ ok: z.literal(false), ...sourceRefusalFields }),
])

/** The site of a «Повторить» or «Изменить доступ», with what the rules of both read. */
const retrySelect = {
  id: true,
  status: true,
  stack: true,
  workspaceId: true,
  url: true,
  provisioningStages: { ...codeImportOnly, select: { status: true } },
  codeSource: { select: { kind: true, host: true, port: true, hostKey: true } },
} as const

const replaceOutput = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('replaced') }),
  z.object({ outcome: z.literal('source_refused'), ...sourceRefusalFields }),
])
type ReplaceOutcome = z.infer<typeof replaceOutput>

const editableAccessOutput = z.object({
  canChange: z.boolean(),
  busy: z.enum(['release', 'unresolved', 'setup']).nullable(),
  source: z
    .object({
      kind: z.enum(siteSourceKinds),
      host: z.string(),
      port: z.number().int(),
      rootPath: z.string().nullable(),
      tls: z.enum(connectionTlsModes).nullable(),
      hostKey: z.string().nullable(),
    })
    .nullable(),
  database: z
    .object({
      engine: z.enum(databaseEngines),
      host: z.string(),
      port: z.number().int(),
      databaseName: z.string(),
      tls: z.enum(connectionTlsModes),
    })
    .nullable(),
})

/** The lock of the user's row, as `project.create` takes it: the imports in progress are counted under it. */
async function lockUser(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, userId: string) {
  if (!(await lockUserRow(tx, userId))) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Войдите, чтобы продолжить' })
  }
}

export const siteConnectionRouter = router({
  /**
   * Step 1, «Далее»: the name and the address as they will be stored, and whether the user has room for the
   * site — the rules of `project.create`, read without the lock and without writing anything.
   */
  checkBasics: consentedProcedure
    .input(z.strictObject({ name: profileNameSchema, url: siteOrigin, stack: z.enum(SiteStack) }))
    .output(
      z.object({ name: z.string(), url: z.string(), host: z.string(), stack: z.enum(SiteStack) }),
    )
    .mutation(async ({ ctx, input }) => {
      const services = requireSiteConnections(ctx.siteConnections)
      assertSiteAccepted(services, input)
      const owner = { userId: ctx.user.id, appEnv: services.appEnv }
      await assertRoomForSiteSnapshot(ctx.prisma, owner, input.url)
      return withHost(input)
    }),

  /**
   * Step 2, «Далее»: a real check of the files — the address, the connection and the login, the folder and
   * the markers of the platform, one bounded read. Nothing is written, here or on the server. An sftp check
   * without a key answers `host_key_unknown` with the key the server presented and sends no credential.
   */
  checkSource: consentedProcedure
    .input(z.strictObject({ stack: z.enum(SiteStack), source: codeSourceInputSchema }))
    .output(sourceCheckOutput)
    .mutation(async ({ ctx, input }) => {
      const services = requireSiteConnections(ctx.siteConnections)
      assertStackConnectable(services, input.stack)
      if (!offersSource(services, input.source.kind))
        return { ok: false as const, reason: 'unsupported' as const }
      const { source } = await gatedChecks(services, {
        userId: ctx.user.id,
        units: 1,
        stack: input.stack,
        source: input.source,
        database: null,
        pinRequired: false,
        ms: siteConnectionLimits.checkMs,
      })
      return source.ok
        ? { ok: true as const, hostKey: source.hostKey, entries: source.entries }
        : { ok: false as const, ...sourceRefusal(source) }
    }),

  /** The screen «Настраиваем сайт», polled by the page of the site; NOT_FOUND for a site of someone else. */
  setup: consentedProcedure
    .input(z.strictObject({ id: z.uuid() }))
    .output(setupOutput)
    .query(({ ctx, input }) => readSiteSetup(ctx.prisma, ctx.user.id, input.id)),

  /**
   * «Повторить»: the next attempt of a failed import, at most retriesPerHour an hour with replaceAccess, and
   * only while the user has fewer than connectionsInProgressPerUser imports in progress.
   */
  retry: consentedProcedure
    .input(z.strictObject({ id: z.uuid() }))
    .output(setupOutput)
    .mutation(async ({ ctx, input }) => {
      const site = await ctx.prisma.site.findFirst({
        where: accessibleSite(ctx.user.id, input.id),
        select: retrySelect,
      })
      if (!site) throw siteNotFound()
      await assertRetryable(ctx.prisma, site)
      await ctx.prisma.$transaction(async (tx) => {
        await lockUser(tx, ctx.user.id)
        await assertConnectionsNotBusy(tx, ctx.user.id)
        await requeueFailedImport(tx, {
          siteId: site.id,
          workspaceId: site.workspaceId,
          userId: ctx.user.id,
          headers: ctx.headers,
          action: SETUP_RETRY_ACTION,
          meta: {},
        })
      })
      return readSiteSetup(ctx.prisma, ctx.user.id, site.id)
    }),

  /**
   * «Изменить доступ» on a failed import: the new access is checked like at creation (an sftp key is
   * required), written to Vault as the next version of its path before the transaction, and the import is
   * queued again with it. A refused check writes nothing. An sftp key other than the one pinned for the same
   * host and port is refused as `host_key_changed` before any connection, unless `acceptNewHostKey` says the
   * user accepted it. The secret of a replaced kind stays in Vault without a reference (default «ж»).
   */
  replaceAccess: consentedProcedure
    .input(
      z.strictObject({
        id: z.uuid(),
        source: codeSourceInputSchema,
        /** «Принять новый ключ»: the user saw the key of the server change and accepts the new one. */
        acceptNewHostKey: z.boolean().optional(),
      }),
    )
    .output(replaceOutput)
    .mutation(async ({ ctx, input }): Promise<ReplaceOutcome> => {
      const services = requireSiteConnections(ctx.siteConnections)
      const userId = ctx.user.id
      const site = await ctx.prisma.site.findFirst({
        where: accessibleSite(userId, input.id),
        select: retrySelect,
      })
      if (!site) throw siteNotFound()
      await assertRetryable(ctx.prisma, site)
      assertStackConnectable(services, site.stack)
      const { source } = input
      if (!offersSource(services, source.kind))
        return { outcome: 'source_refused', reason: 'unsupported' }
      const accepted = input.acceptNewHostKey === true
      const changed = unacceptedHostKey(services, site.codeSource, source, accepted)
      if (changed) return changed
      // Fail fast, before any connection to a server: the transaction counts again under the lock.
      await assertConnectionsNotBusy(ctx.prisma, userId)

      const budget = deadline(siteConnectionLimits.createBudgetMs)
      let stored: StoredAccess<CodeSourceTarget>
      let prepared: PreparedAccess<CodeSourceTarget>
      try {
        const checked = await gatedChecks(services, {
          userId,
          units: 2,
          stack: site.stack,
          source,
          database: null,
          pinRequired: true,
          ms: siteConnectionLimits.checkMs,
          parent: budget.signal,
        })
        if (!checked.source.ok) {
          return { outcome: 'source_refused', ...sourceRefusal(checked.source) }
        }
        const { ok: _ok, ...passed } = checked.source
        prepared = services.sources(source.kind).prepare(source, passed)
        stored = await storeSiteAccess(services.secrets, {
          siteId: site.id,
          prepared,
          signal: budget.signal,
        })
      } finally {
        budget.end()
      }

      const { accessKind, target, vaultPath, version } = stored
      let replacedKind = false
      let previousSourceKind: string | null = null
      let outcome: ReplaceOutcome
      try {
        outcome = await ctx.prisma.$transaction(
          async (tx): Promise<ReplaceOutcome> => {
            // The user's row first, as project.create takes it, then the row of the stage: a concurrent
            // «Повторить» or «Изменить доступ» waits for this one, and then finds the import queued.
            await lockUser(tx, userId)
            const [stage] = await tx.$queryRaw<{ status: string }[]>`
              SELECT status::text AS status FROM site_provisioning_stages
              WHERE site_id = ${site.id}::uuid AND stage = 'code_import'
              FOR UPDATE
            `
            if (stage?.status !== 'failed') throw notFailed()
            // The row of the source as it is now, held until the commit: a replacement that committed since
            // the read above decides which key is pinned and which reference this one replaces.
            const [current] = await tx.$queryRaw<(PinnedSource & { credentialRefId: string })[]>`
              SELECT kind::text AS kind, host, port, host_key AS "hostKey",
                     credential_ref_id::text AS "credentialRefId"
              FROM site_code_sources
              WHERE site_id = ${site.id}::uuid
              FOR UPDATE
            `
            const refused = unacceptedHostKey(services, current, source, accepted)
            if (refused) return refused
            previousSourceKind = current?.kind ?? null
            await assertConnectionsNotBusy(tx, userId)
            const ref = await tx.credentialRef.upsert({
              where: { vaultPath },
              create: {
                kind: accessKind,
                workspaceId: site.workspaceId,
                siteId: site.id,
                vaultPath,
                keyVersion: version,
              },
              update: { keyVersion: version },
              select: { id: true },
            })
            const columns = { ...codeSourceColumns(target), credentialRefId: ref.id }
            await tx.siteCodeSource.upsert({
              where: { siteId: site.id },
              create: { siteId: site.id, ...columns },
              update: columns,
            })
            // The reference of the other kind goes once nothing refers to it; its secret stays behind.
            const previous = current?.credentialRefId
            if (previous !== undefined && previous !== ref.id) {
              const { count } = await tx.credentialRef.deleteMany({
                where: {
                  id: previous,
                  siteId: site.id,
                  codeSources: { none: {} },
                  databases: { none: {} },
                  gitRepositories: { none: {} },
                  llmProviders: { none: {} },
                  subscriptionAccount: { is: null },
                },
              })
              replacedKind = count === 1
            }
            await requeueFailedImport(tx, {
              siteId: site.id,
              workspaceId: site.workspaceId,
              userId,
              headers: ctx.headers,
              action: ACCESS_REPLACE_ACTION,
              meta: { kind: accessKind, version },
            })
            return { outcome: 'replaced' }
          },
          { isolationLevel: 'ReadCommitted' },
        )
      } catch (error) {
        // The new version is in Vault and the reference still names the old one.
        logOrphanedSecrets(site.id)
        throw error
      }
      // A key refused under the lock leaves the version just written without a reference too.
      if (outcome.outcome !== 'replaced' || replacedKind) logOrphanedSecrets(site.id)
      if (outcome.outcome === 'replaced')
        // The accesses are the site's variables too (owner's decision of 26.10.2026).
        await replaceAccessVariables(ctx.prisma, services.secrets, {
          siteId: site.id,
          userId,
          siteUrl: site.url,
          prepared,
          previousAccessKind: accessKindOf(services, previousSourceKind),
          reference: { vaultPath: stored.vaultPath, version: stored.version },
          now: new Date(),
        })
      return outcome
    }),

  /**
   * «Переменные → Доступы»: whether the user may change the accesses of the site, why not now, and the
   * public columns a form starts from — never a login or a secret. Reads PostgreSQL only.
   */
  editableAccess: consentedProcedure
    .input(z.strictObject({ id: z.uuid() }))
    .output(editableAccessOutput)
    .query(({ ctx, input }) => readEditableAccess(ctx.prisma, ctx.user.id, input.id)),

  /**
   * «Изменить» the access to the files of a working site (owner's request of 26.10.2026): saved only once
   * the check with it passed — as at creation, an sftp key required and compared with the pinned one, and
   * `acceptNewHostKey` for a key the user saw change. Nothing is queued; refused while a release or the
   * first import goes on (services/site-access-change.ts).
   */
  changeSource: consentedProcedure
    .input(
      z.strictObject({
        id: z.uuid(),
        source: codeSourceInputSchema,
        acceptNewHostKey: z.boolean().optional(),
      }),
    )
    .output(replaceOutput)
    .mutation(({ ctx, input }) =>
      changeSiteSource({
        db: ctx.prisma,
        services: requireSiteConnections(ctx.siteConnections),
        userId: ctx.user.id,
        headers: ctx.headers,
        siteId: input.id,
        source: input.source,
        acceptNewHostKey: input.acceptNewHostKey === true,
      }),
    ),

  /** «Изменить» the access to the database of a working site: saved only once `SELECT 1` passed with it. */
  changeDatabase: consentedProcedure
    .input(z.strictObject({ id: z.uuid(), database: databaseInputSchema }))
    .output(
      z.discriminatedUnion('outcome', [
        z.object({ outcome: z.literal('replaced') }),
        z.object({ outcome: z.literal('database_refused'), reason: reasonSchema }),
      ]),
    )
    .mutation(({ ctx, input }) =>
      changeSiteDatabase({
        db: ctx.prisma,
        services: requireSiteConnections(ctx.siteConnections),
        userId: ctx.user.id,
        headers: ctx.headers,
        siteId: input.id,
        database: input.database,
      }),
    ),
})
