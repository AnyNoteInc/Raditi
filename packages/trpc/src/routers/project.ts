import { randomUUID } from 'node:crypto'

import { clientIp, profileNameSchema } from '@repo/auth'
import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import type { CredentialKind } from '@repo/db'
import {
  enqueueSiteProvisioningStage,
  findPersonalWorkspace,
  lockUserRow,
  Prisma,
  SiteStack,
  SiteStatus,
} from '@repo/db'
import {
  codeSourceInputSchema,
  connectionCheckReasons,
  databaseInputSchema,
  DomainError,
  siteConnectionLimits,
  siteSetupState,
  type CodeSourceTarget,
  type DatabaseTarget,
} from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  codeSourceColumns,
  databaseColumns,
  deadline,
  gatedChecks,
  logOrphanedSecrets,
  offersSource,
  requireSiteConnections,
  siteConnectionUnavailable,
  sourceRefusal,
  storeSiteAccess,
  type StoredAccess,
} from '../services/site-access.ts'
import {
  accessibleSite,
  alreadyExists,
  assertRoomForSite,
  assertSiteAccepted,
  siteNotFound,
  siteOrigin,
  withHost,
} from '../services/site-basics.ts'
import { siteIdForRequest } from '../services/site-request-id.ts'
import {
  codeImportOnly,
  confirmedInitialVersion,
  initialVersionOutput,
  siteSetupStates,
} from '../services/site-setup.ts'
import { consentedProcedure, router } from '../trpc.ts'
import { sourceRefusalFields } from './site-connection.ts'

export { MAX_SITES_PER_USER } from '../services/site-basics.ts'

const projectSelect = {
  id: true,
  name: true,
  url: true,
  stack: true,
  status: true,
  createdAt: true,
} satisfies Prisma.SiteSelect

const projectOutput = z.object({
  id: z.uuid(),
  name: z.string(),
  url: z.string(),
  host: z.string(),
  stack: z.enum(SiteStack),
  status: z.enum(SiteStatus),
  createdAt: z.date(),
})

/** Whether the page of the site shows «Настраиваем сайт» (siteSetupState); null for a site from before it. */
const setupField = z.enum(siteSetupStates).nullable()

const listOutput = projectOutput.extend({ setup: setupField })

/** The kinds of access a site itself has; a row of any other kind is not shown on its page. */
const SITE_ACCESS_KINDS = [
  'ssh',
  'ftp',
  'wp',
  'browser',
  'db',
] as const satisfies readonly CredentialKind[]

/**
 * What stands between the site and a new operation, by the rule of the lease store
 * (`site-leases.ts`): `held` — the outcome of the last operation is unknown, by a hold for the
 * operator or by a content write that was not confirmed; `busy` — a turn, a deploy or a revert
 * is running; `free` — nothing.
 */
function siteState(
  lease: {
    operation: unknown
    expiresAt: Date | null
    heldForOperator: boolean
    inflightMcpCallId: string | null
  } | null,
): 'free' | 'busy' | 'held' {
  if (!lease) return 'free'
  if (lease.heldForOperator || lease.inflightMcpCallId !== null) return 'held'
  const running =
    lease.operation !== null && (lease.expiresAt === null || lease.expiresAt > new Date())
  return running ? 'busy' : 'free'
}

const siteOutput = projectOutput.extend({
  /** Nothing new starts on a site that is `busy` or `held`. */
  state: z.enum(['free', 'busy', 'held']),
  setup: setupField,
  initialVersion: initialVersionOutput,
})

/** A saved access of the site as its owner may see it: never the Vault path, never a value. */
const credentialOutput = z.object({
  kind: z.enum(SITE_ACCESS_KINDS),
  version: z.number().int(),
  updatedAt: z.date(),
})

const createOutput = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('created'), project: projectOutput }),
  /** The files: checked again, and refused this time. Nothing was written. */
  z.object({ outcome: z.literal('source_refused'), ...sourceRefusalFields }),
  /** The database: checked again, and refused this time. Nothing was written. */
  z.object({ outcome: z.literal('database_refused'), reason: z.enum(connectionCheckReasons) }),
])
type CreateOutcome = z.infer<typeof createOutput>

const creationInProgress = () =>
  new DomainError('PROJECT_CREATION_IN_PROGRESS', 'The same project is being created', 409)

/**
 * A site with the id of this request already exists: the same request again (its answer was lost) when the
 * address is the one it was created with — that answer once more, nothing checked or written —, another
 * request under a reused key otherwise. A site with that id that the user cannot open answers as one that
 * does not exist.
 */
async function replayOf(
  db: Pick<Prisma.TransactionClient, 'site'>,
  { userId, siteId, url }: { userId: string; siteId: string; url: string },
): Promise<CreateOutcome | null> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: {
      ...projectSelect,
      workspace: { select: { members: { where: { userId }, select: { userId: true }, take: 1 } } },
    },
  })
  if (!site) return null
  const { workspace, ...row } = site
  if (workspace.members.length === 0) throw siteNotFound()
  if (row.url !== url) {
    throw new DomainError(
      'PROJECT_REQUEST_CONFLICT',
      'The request key was used for another project',
      409,
    )
  }
  return { outcome: 'created', project: withHost(row) }
}

/**
 * Holds the id of the site being created for createClaimMs (docs/plan/39-site-connection-wizard.md, step 2),
 * by the clock of PostgreSQL: a second identical request is refused instead of writing Vault at the same
 * time, and a claim that outlived its request is taken over. false when another one holds it.
 */
async function claimCreation(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  claim: { siteId: string; userId: string; token: string },
): Promise<boolean> {
  const rows = await db.$queryRaw<{ token: string }[]>`
    INSERT INTO site_creation_claims (site_id, user_id, token, expires_at)
    VALUES (
      ${claim.siteId}::uuid, ${claim.userId}::uuid, ${claim.token}::uuid,
      now() + ${siteConnectionLimits.createClaimMs}::int * interval '1 millisecond'
    )
    ON CONFLICT (site_id) DO UPDATE
      SET user_id = EXCLUDED.user_id, token = EXCLUDED.token, expires_at = EXCLUDED.expires_at,
          created_at = now()
      WHERE site_creation_claims.expires_at < now()
    RETURNING token::text AS token
  `
  return rows.length === 1
}

/** Best effort: a claim left behind expires on its own. */
async function releaseCreation(
  db: Pick<Prisma.TransactionClient, 'siteCreationClaim'>,
  claim: { siteId: string; token: string },
): Promise<void> {
  await db.siteCreationClaim
    .deleteMany({ where: { siteId: claim.siteId, token: claim.token } })
    .catch(() => undefined)
}

export const projectRouter = router({
  list: consentedProcedure.output(z.array(listOutput)).query(async ({ ctx }) => {
    const sites = await ctx.prisma.site.findMany({
      where: { workspace: { members: { some: { userId: ctx.user.id } } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        ...projectSelect,
        provisioningStages: { ...codeImportOnly, select: { status: true } },
      },
    })
    return sites.map(({ provisioningStages, ...site }) => ({
      ...withHost(site),
      setup: siteSetupState(provisioningStages[0]),
    }))
  }),

  /** One site of the user, for its page in the cabinet. */
  get: consentedProcedure
    .input(z.strictObject({ id: z.uuid() }))
    .output(siteOutput)
    .query(async ({ ctx, input }) => {
      const site = await ctx.prisma.site.findFirst({
        where: accessibleSite(ctx.user.id, input.id),
        select: {
          ...projectSelect,
          lease: {
            select: {
              operation: true,
              expiresAt: true,
              heldForOperator: true,
              inflightMcpCallId: true,
            },
          },
          provisioningStages: { ...codeImportOnly, select: { status: true } },
          initialVersion: { select: { tag: true, commitSha: true, importedAt: true } },
        },
      })
      if (!site) throw siteNotFound()
      const { lease, provisioningStages, initialVersion, ...row } = site
      return {
        ...withHost(row),
        state: siteState(lease),
        setup: siteSetupState(provisioningStages[0]),
        initialVersion: confirmedInitialVersion(initialVersion),
      }
    }),

  /** Which accesses of the site are saved: kind, version and date — the secrets stay in Vault. */
  credentials: consentedProcedure
    .input(z.strictObject({ id: z.uuid() }))
    .output(z.array(credentialOutput))
    .query(async ({ ctx, input }) => {
      const site = await ctx.prisma.site.findFirst({
        where: accessibleSite(ctx.user.id, input.id),
        select: {
          credentialRefs: {
            where: { kind: { in: [...SITE_ACCESS_KINDS] } },
            orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
            select: { kind: true, keyVersion: true, updatedAt: true },
          },
        },
      })
      if (!site) throw siteNotFound()
      return site.credentialRefs.map((ref) => ({
        // The query asked for these kinds only.
        kind: ref.kind as (typeof SITE_ACCESS_KINDS)[number],
        version: ref.keyVersion,
        updatedAt: ref.updatedAt,
      }))
    }),

  /**
   * «Добавить проект», the only way a project is made (docs/plan/39-site-connection-wizard.md, «Создание»):
   * the site, the references of its accesses, where its files and database are, and its first import
   * queued — or nothing. In order: the id of the site from the user and `requestKey` (a repeated request
   * finds its site and answers again), the rules of «Основные данные» without the lock, the claim of the id,
   * both accesses checked again (a passed step of the wizard proves nothing now), their secrets written to
   * Vault before the transaction, then one transaction that checks the rules again under the lock of the
   * user's row and writes everything. A refused check answers `source_refused` or `database_refused`, with
   * nothing written anywhere.
   */
  create: consentedProcedure
    .input(
      z.strictObject({
        /** One per opening of the wizard: the same key again is the same request. */
        requestKey: z.uuid(),
        // A one-line name, by the rule of every other name a user types (`sites.name`, VarChar 255).
        name: profileNameSchema,
        url: siteOrigin,
        stack: z.enum(SiteStack),
        source: codeSourceInputSchema,
        database: databaseInputSchema.nullable(),
      }),
    )
    .output(createOutput)
    .mutation(async ({ ctx, input }): Promise<CreateOutcome> => {
      const services = requireSiteConnections(ctx.siteConnections)
      const userId = ctx.user.id
      const { appEnv } = services
      const siteId = siteIdForRequest(userId, input.requestKey)
      const request = { userId, siteId, url: input.url }

      const replay = await replayOf(ctx.prisma, request)
      if (replay) return replay

      // Fail fast, before any connection to a server: the transaction asks all of this again.
      assertSiteAccepted(services, input)
      const owner = { userId, appEnv }
      try {
        await assertRoomForSite(ctx.prisma, request, () => findPersonalWorkspace(ctx.prisma, owner))
      } catch (error) {
        // An identical request may have committed since the replay above: its own site is then the
        // duplicate, or the site or the import that leaves no room. That site is the answer.
        const raced = await replayOf(ctx.prisma, request)
        if (raced) return raced
        throw error
      }
      const { source, database } = input
      if (!offersSource(services, source.kind))
        return { outcome: 'source_refused', reason: 'unsupported' }

      // Everything before the transaction fits the budget, and the claim outlives the budget and the
      // transaction: while it is held, nothing else writes the secrets of this site.
      const budget = deadline(siteConnectionLimits.createBudgetMs)
      const claim = { siteId, userId, token: randomUUID() }
      let written = false
      let committed = false
      try {
        if (!(await claimCreation(ctx.prisma, claim))) throw creationInProgress()
        // An identical request may have committed between the replay above and the claim.
        const raced = await replayOf(ctx.prisma, request)
        if (raced) return raced

        const checked = await gatedChecks(services, {
          userId,
          units: 2,
          stack: input.stack,
          source,
          database,
          pinRequired: true,
          ms: siteConnectionLimits.createChecksMs,
          parent: budget.signal,
        })
        if (!checked.source.ok)
          return { outcome: 'source_refused', ...sourceRefusal(checked.source) }
        if (checked.database?.ok === false) {
          return { outcome: 'database_refused', reason: checked.database.reason }
        }

        const { ok: _ok, ...passed } = checked.source
        const sourceAccess = services.sources(source.kind).prepare(source, passed)
        const databaseAccess = database
          ? services.databases(database.engine).prepare(database)
          : null
        written = true
        const stored: {
          source: StoredAccess<CodeSourceTarget>
          database: StoredAccess<DatabaseTarget> | null
        } = {
          source: await storeSiteAccess(services.secrets, {
            siteId,
            prepared: sourceAccess,
            signal: budget.signal,
          }),
          database: databaseAccess
            ? await storeSiteAccess(services.secrets, {
                siteId,
                prepared: databaseAccess,
                signal: budget.signal,
              })
            : null,
        }
        if (budget.signal.aborted) throw siteConnectionUnavailable()
        budget.end()

        const outcome = await ctx.prisma.$transaction(
          async (tx): Promise<CreateOutcome> => {
            // Serialize this user's first and subsequent projects across web replicas: the
            // duplicate, the ceiling, the tariff and the imports in progress are checked under it.
            if (!(await lockUserRow(tx, userId))) {
              throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Войдите, чтобы продолжить' })
            }
            // Still ours: a claim that expired and was taken over belongs to the request that took it.
            const { count } = await tx.siteCreationClaim.deleteMany({
              where: { siteId, token: claim.token },
            })
            if (count !== 1) throw creationInProgress()
            // Only after a claim that expired under an earlier identical request, which then committed:
            // its site is the answer, and the versions written above are newer than its references.
            const earlier = await replayOf(tx, request)
            if (earlier) {
              logOrphanedSecrets(siteId)
              return earlier
            }

            const workspace = await assertRoomForSite(tx, request, () =>
              ensurePersonalWorkspaceWithGift(tx, owner),
            )
            const site = await tx.site.create({
              data: {
                id: siteId,
                name: input.name,
                url: input.url,
                stack: input.stack,
                workspaceId: workspace.id,
                status: 'onboarding',
              },
              select: projectSelect,
            })
            const reference = (access: StoredAccess<unknown>) =>
              tx.credentialRef.create({
                data: {
                  kind: access.accessKind,
                  workspaceId: workspace.id,
                  siteId,
                  vaultPath: access.vaultPath,
                  keyVersion: access.version,
                },
                select: { id: true },
              })
            const sourceRef = await reference(stored.source)
            await tx.siteCodeSource.create({
              data: {
                siteId,
                ...codeSourceColumns(stored.source.target),
                credentialRefId: sourceRef.id,
              },
            })
            if (stored.database) {
              const databaseRef = await reference(stored.database)
              await tx.siteDatabase.create({
                data: {
                  siteId,
                  ...databaseColumns(stored.database.target),
                  credentialRefId: databaseRef.id,
                },
              })
            }
            await tx.siteProvisioningStage.create({
              data: {
                siteId,
                stage: 'code_import',
                status: 'queued',
                attempt: 1,
                enqueues: 1,
                step: null,
              },
            })
            await enqueueSiteProvisioningStage(tx, {
              siteId,
              stage: 'code_import',
              attempt: 1,
              enqueues: 1,
            })
            // Kinds only: no host, no folder, no name of the database.
            await tx.auditLog.create({
              data: {
                actorType: 'user',
                actorId: userId,
                workspaceId: workspace.id,
                action: 'site.create',
                targetType: 'site',
                targetId: siteId,
                meta: {
                  source: stored.source.target.kind,
                  database: stored.database?.target.engine ?? null,
                },
                ip: clientIp(ctx.headers),
              },
            })
            return { outcome: 'created', project: withHost(site) }
          },
          // The transaction timeout the claim is sized for (createClaimMs).
          { isolationLevel: 'ReadCommitted', timeout: 10_000 },
        )
        committed = true
        return outcome
      } catch (error) {
        // The secrets stay in Vault without a reference; the next request with this key writes over them.
        if (written) logOrphanedSecrets(siteId)
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw alreadyExists()
        }
        throw error
      } finally {
        budget.end()
        // The transaction deleted the claim with the site; every other way out gives it back.
        if (!committed) await releaseCreation(ctx.prisma, claim)
      }
    }),
})
