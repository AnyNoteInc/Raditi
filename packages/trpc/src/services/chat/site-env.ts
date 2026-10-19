import { Prisma, type PrismaClient } from '@repo/db'
import {
  containsEnvValue,
  dbPlanViewTexts,
  egressHostLimits,
  egressHostListSchema,
  egressHostsOf,
  envVarLimits,
  envVarNameProblem,
  envVarsMayReachAgent,
  envVarValueSchema,
  siteEnvVarPath,
  siteEnvVarSecret,
  siteEnvVarTombstone,
  type SecretStore,
} from '@repo/domain'

import { accessibleSite, siteNotFound } from '../../routers/project.ts'
import { isManagerRole, memberRole } from './access.ts'
import {
  siteEnvAgentClosed,
  siteEnvChanged,
  siteEnvConsentRequired,
  siteEnvHostsInvalid,
  siteEnvHostsLimit,
  siteEnvLimit,
  siteEnvNameInvalid,
  siteEnvNameReserved,
  siteEnvNotAllowed,
  siteEnvValueInvalid,
} from './refusals.ts'

// The client's variables of a site (docs/plan/53-chat-preview-release.md, Р13): the value of
// each in Vault `kv/sites/<siteId>/env/<NAME>`, written here under `sites-writer` and never read
// back; the name, the hosts it may reach and whom it goes to in `site_env_vars`. Only an owner
// or an admin of the workspace sees or changes them, and nobody ever gets a value back.

/** A variable as its page shows it: never the value. */
export interface SiteEnvVarView {
  name: string
  /** `host:port` it may reach. */
  hosts: string[]
  toAgent: boolean
  toPreview: boolean
  /** When the client agreed that the agent sees what the service returns. */
  agentConsentAt: Date | null
  keyVersion: number
  updatedAt: Date
}

const viewSelect = {
  name: true,
  hosts: true,
  toAgent: true,
  toPreview: true,
  agentConsentAt: true,
  keyVersion: true,
  updatedAt: true,
} satisfies Prisma.SiteEnvVarSelect

function viewOf(row: Prisma.SiteEnvVarGetPayload<{ select: typeof viewSelect }>): SiteEnvVarView {
  const hosts = egressHostListSchema.safeParse(row.hosts)
  return { ...row, hosts: hosts.success ? hosts.data : [] }
}

/** The site of an owner or an admin: NOT_FOUND for a stranger, a refusal for a member. */
async function managedSite(
  db: PrismaClient,
  userId: string,
  siteId: string,
): Promise<{ id: string; workspaceId: string; dataClass: 'synthetic' | 'client' }> {
  const site = await db.site.findFirst({
    where: accessibleSite(userId, siteId),
    select: { id: true, workspaceId: true, workspace: { select: { dataClass: true } } },
  })
  if (site === null) throw siteNotFound()
  if (!isManagerRole(await memberRole(db, site.workspaceId, userId))) throw siteEnvNotAllowed()
  return { id: site.id, workspaceId: site.workspaceId, dataClass: site.workspace.dataClass }
}

/** The variables of a site, and whether its workspace may give any of them to the agent. */
export interface SiteEnvList {
  /**
   * false in a workspace of real client data before the gate of 152-FZ (`envVarsMayReachAgent`):
   * the form keeps «Передавать агенту» off, and `set` with it on is SITE_ENV_AGENT_CLOSED.
   */
  agentAllowed: boolean
  variables: SiteEnvVarView[]
}

export async function listSiteEnv(
  db: PrismaClient,
  input: { userId: string; siteId: string },
): Promise<SiteEnvList> {
  const site = await managedSite(db, input.userId, input.siteId)
  const rows = await db.siteEnvVar.findMany({
    where: { siteId: site.id },
    orderBy: { name: 'asc' },
    select: viewSelect,
  })
  return { agentAllowed: envVarsMayReachAgent(site.dataClass), variables: rows.map(viewOf) }
}

export interface SiteEnvVarSetInput {
  userId: string
  siteId: string
  name: string
  value: string
  hosts: readonly string[]
  toPreview: boolean
  toAgent: boolean
  /** The client read «агент увидит то, что вернёт этот сервис» and agreed. */
  agentConsent: boolean
  now: Date
}

/**
 * Writes the value of a variable to Vault by CAS — the version the key has, 0 for a new one —
 * and returns the version written. Another writer in between is SITE_ENV_CHANGED: the client
 * sees the page again rather than overwrite what someone else set. The key keeps one version
 * (`maxVersions: 1`): the same write deletes the value it replaces, or the one a tombstone
 * removes, so nobody — `core` included — reads a changed or removed value back.
 */
async function writeValue(
  secrets: SecretStore,
  path: string,
  data: Record<string, string>,
): Promise<number> {
  const metadata = await secrets.kvMetadata(path)
  const cas = metadata?.currentVersion ?? 0
  try {
    return (await secrets.kvWrite(path, data, { cas, maxVersions: 1 })).version
  } catch (error) {
    const now = await secrets.kvMetadata(path)
    if ((now?.currentVersion ?? 0) !== cas) throw siteEnvChanged()
    throw error
  }
}

/**
 * Adds or changes a variable (Р13): the value goes to Vault first, then the row records the
 * version that holds it — a row never names a value Vault does not have. Of two writers the
 * later version wins in the row as it does in Vault. The agent gets a variable only with the
 * client's consent, and in a workspace of real client data not before the gate of 152-FZ
 * (rule 1).
 */
export async function setSiteEnv(
  db: PrismaClient,
  secrets: () => SecretStore,
  input: SiteEnvVarSetInput,
): Promise<SiteEnvVarView> {
  const problem = envVarNameProblem(input.name)
  if (problem === 'format') throw siteEnvNameInvalid()
  if (problem === 'reserved') throw siteEnvNameReserved()
  if (!envVarValueSchema.safeParse(input.value).success) throw siteEnvValueInvalid()
  const hosts = egressHostListSchema.safeParse(input.hosts)
  if (!hosts.success) throw siteEnvHostsInvalid()
  const site = await managedSite(db, input.userId, input.siteId)
  if (input.toAgent) {
    if (!input.agentConsent) throw siteEnvConsentRequired()
    // Until the gate of 152-FZ nothing of real client data reaches the agent (Р13, rule 1).
    if (!envVarsMayReachAgent(site.dataClass)) throw siteEnvAgentClosed()
  }
  const others = await db.siteEnvVar.findMany({
    where: { siteId: site.id, name: { not: input.name } },
    select: { hosts: true },
  })
  if (others.length >= envVarLimits.perSite) throw siteEnvLimit()
  // The hosts of all the variables travel to one proxy of a sandbox and of a preview (Р13).
  const reached = egressHostsOf([
    ...others.map((row) => ({ hosts: egressHostListSchema.catch([]).parse(row.hosts) })),
    { hosts: hosts.data },
  ])
  if (reached.length > egressHostLimits.perSite) throw siteEnvHostsLimit()

  const version = await writeValue(
    secrets(),
    siteEnvVarPath(site.id, input.name),
    siteEnvVarSecret(input.value),
  )
  const fields = {
    hosts: hosts.data,
    toAgent: input.toAgent,
    toPreview: input.toPreview,
    agentConsentAt: input.toAgent ? input.now : null,
    agentConsentBy: input.toAgent ? input.userId : null,
    keyVersion: version,
  }
  // The row and the look at the descriptions under the lock of the site that the record of a
  // revision takes (`recordCandidate` of @repo/db): a description recorded before is taken back
  // here, one recorded after finds this row and is recorded without its values.
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM sites WHERE id = ${site.id}::uuid FOR NO KEY UPDATE`
    const created = await tx.siteEnvVar.createMany({
      data: [{ siteId: site.id, name: input.name, createdBy: input.userId, ...fields }],
      skipDuplicates: true,
    })
    // The later version of Vault wins: a slower writer of an older version changes nothing.
    if (created.count === 0) {
      await tx.siteEnvVar.updateMany({
        where: { siteId: site.id, name: input.name, keyVersion: { lt: version } },
        data: fields,
      })
    }
    await takeBackDescriptions(tx, site.id, input.value)
  })
  const row = await db.siteEnvVar.findUniqueOrThrow({
    where: { siteId_name: { siteId: site.id, name: input.name } },
    select: viewSelect,
  })
  return viewOf(row)
}

/**
 * The description of a database plan core keeps in the clear with an open candidate (docs/plan/
 * 53, «Операции БД и миграции») must not hold the value of a variable — a value the client
 * declares a variable after the description was made included: such a description is taken
 * back. Compared here, in this process: the value never travels in a query. The candidate is
 * then not released until a new revision describes its plan again (`values_unavailable`).
 */
async function takeBackDescriptions(
  db: Pick<Prisma.TransactionClient, 'taskCandidate'>,
  siteId: string,
  value: string,
) {
  const candidates = await db.taskCandidate.findMany({
    where: { task: { siteId }, status: { in: ['current', 'stale'] }, dbViewSha256: { not: null } },
    select: { id: true, dbView: true },
  })
  const holding = candidates
    .filter((candidate) =>
      dbPlanViewTexts(candidate.dbView).some((text) => containsEnvValue(text, [value])),
    )
    .map((candidate) => candidate.id)
  if (holding.length > 0)
    await db.taskCandidate.updateMany({
      where: { id: { in: holding } },
      data: { dbView: Prisma.DbNull, dbViewSha256: null },
    })
}

/**
 * Removes a variable: Vault gets a version without a value (the policy cannot delete; a reader
 * takes it for an absent variable), then the row goes — unless a later value was set meanwhile.
 * A variable that is not there is removed already.
 */
export async function removeSiteEnv(
  db: PrismaClient,
  secrets: () => SecretStore,
  input: { userId: string; siteId: string; name: string; now: Date },
): Promise<{ removed: boolean }> {
  const site = await managedSite(db, input.userId, input.siteId)
  if (envVarNameProblem(input.name) !== null) return { removed: false }
  const row = await db.siteEnvVar.findUnique({
    where: { siteId_name: { siteId: site.id, name: input.name } },
    select: { keyVersion: true },
  })
  if (row === null) return { removed: false }
  const store = secrets()
  const path = siteEnvVarPath(site.id, input.name)
  // A key that was never written has nothing to hide; otherwise the version without a value.
  const written = (await store.kvMetadata(path)) !== null
  const deleted = await db.siteEnvVar.deleteMany({
    where: written
      ? {
          siteId: site.id,
          name: input.name,
          keyVersion: { lt: await writeValue(store, path, siteEnvVarTombstone(input.now)) },
        }
      : { siteId: site.id, name: input.name, keyVersion: { lte: row.keyVersion } },
  })
  return { removed: deleted.count > 0 }
}
