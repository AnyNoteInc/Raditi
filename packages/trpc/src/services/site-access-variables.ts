import type { Prisma, PrismaClient } from '@repo/db'
import {
  envVarLimits,
  envVarsMayReachAgent,
  siteAccessVariableNames,
  siteAccessVariables,
  siteEnvVarPath,
  siteEnvVarSecret,
  siteConnectionLimits,
  siteEnvVarTombstone,
  type PreparedAccess,
  type SiteConnectionServices,
} from '@repo/domain'

import { takeBackDescriptions } from './chat/site-env.ts'
import { displayHost } from './site-basics.ts'
import { deadline, failureLabel, writeSiteSecret } from './site-access.ts'

// The accesses of a site as its variables (owner's decision of 26.10.2026): the fields of each
// access the wizard or «Изменить доступ» stores become `kv/sites/<siteId>/env/<NAME>` with a row
// of `site_env_vars`, written the way «Переменные» writes one (`setSiteEnv`): one version of the
// key, CAS, the value never read back. The agent's commands and the preview get them where the
// workspace may give variables to the agent at all — the owner's decision is the consent.

/** A variable written to Vault: its name and the version that holds the value. */
export interface WrittenVariable {
  name: string
  version: number
}

/** The variables of the accesses just prepared: the host of the site address is not one of them. */
export function accessVariablesOf(
  siteUrl: string,
  accesses: readonly (PreparedAccess<unknown> | null)[],
): { name: string; value: string }[] {
  const ascii = URL.parse(siteUrl)?.hostname ?? ''
  const hosts = [ascii, displayHost(siteUrl)]
  return accesses.flatMap((access) =>
    access ? siteAccessVariables(access.accessKind, access.secret, hosts) : [],
  )
}

/**
 * The values to Vault, each as the next version by CAS with one version kept (the write deletes
 * the value it replaces). A failure is SITE_CONNECTION_UNAVAILABLE, as of any secret of the wizard.
 */
export async function writeAccessVariables(
  secrets: SiteConnectionServices['secrets'],
  request: {
    siteId: string
    variables: readonly { name: string; value: string }[]
    signal: AbortSignal
  },
): Promise<WrittenVariable[]> {
  const written: WrittenVariable[] = []
  for (const { name, value } of request.variables) {
    const version = await writeSiteSecret(secrets, {
      path: siteEnvVarPath(request.siteId, name),
      data: siteEnvVarSecret(value),
      signal: request.signal,
      maxVersions: 1,
    })
    written.push({ name, version })
  }
  return written
}

/**
 * The rows of the variables written, in the caller's transaction. A new row gets the recipients
 * of the owner's decision; one that is there keeps what the client set in «Переменные» and only
 * learns the later version — an older version never replaces a newer one. Rows past
 * `envVarLimits.perSite` are not made: the client removes a variable to make room.
 */
export async function recordAccessVariables(
  // At creation no candidate of a dialog exists whose description could hold a value; a replaced
  // or changed access takes such descriptions back itself (`replaceAccessVariables`).
  tx: Pick<Prisma.TransactionClient, 'siteEnvVar'>,
  input: {
    siteId: string
    userId: string
    dataClass: 'synthetic' | 'client'
    written: readonly WrittenVariable[]
    now: Date
  },
): Promise<void> {
  if (input.written.length === 0) return
  const toAgent = envVarsMayReachAgent(input.dataClass)
  const existing = await tx.siteEnvVar.findMany({
    where: { siteId: input.siteId },
    select: { name: true },
  })
  const names = new Set(existing.map((row) => row.name))
  let room = envVarLimits.perSite - names.size
  const created = input.written.filter((variable) => {
    if (names.has(variable.name)) return false
    if (room <= 0) return false
    room -= 1
    return true
  })
  if (created.length > 0)
    await tx.siteEnvVar.createMany({
      data: created.map((variable) => ({
        siteId: input.siteId,
        name: variable.name,
        hosts: [],
        toAgent,
        toPreview: true,
        agentConsentAt: toAgent ? input.now : null,
        agentConsentBy: toAgent ? input.userId : null,
        keyVersion: variable.version,
        createdBy: input.userId,
      })),
      skipDuplicates: true,
    })
  for (const variable of input.written) {
    if (!names.has(variable.name)) continue
    await tx.siteEnvVar.updateMany({
      where: { siteId: input.siteId, name: variable.name, keyVersion: { lt: variable.version } },
      data: { keyVersion: variable.version },
    })
  }
}

/**
 * The variables the new access no longer has: those of a kind the site no longer has (an FTP
 * access replaced by SFTP), and those of a field the new access lacks (an SFTP password replaced
 * by a key, a key without its phrase now) — any name of either kind that was not just written.
 * Their rows go in the caller's transaction, and `eraseReplacedVariables` writes a version without
 * a value.
 */
export function replacedVariableNames(
  previousKind: string | null,
  currentKind: string,
  written: readonly string[],
): string[] {
  const kept = new Set(written)
  const names = new Set([
    ...(previousKind === null ? [] : siteAccessVariableNames(previousKind)),
    ...siteAccessVariableNames(currentKind),
  ])
  return [...names].filter((name) => !kept.has(name))
}

/** A version without a value for each name; a failure leaves the value without a row and logs it. */
export async function eraseReplacedVariables(
  secrets: SiteConnectionServices['secrets'],
  request: { siteId: string; names: readonly string[]; now: Date; signal: AbortSignal },
): Promise<void> {
  for (const name of request.names) {
    const path = siteEnvVarPath(request.siteId, name)
    try {
      if ((await secrets.kvMetadata(path)) === null) continue
      await writeSiteSecret(secrets, {
        path,
        data: siteEnvVarTombstone(request.now),
        signal: request.signal,
        maxVersions: 1,
      })
    } catch (error) {
      console.warn(`site_access_variable_orphan site=${request.siteId} ${failureLabel(error)}`)
    }
  }
}

/**
 * «Изменить доступ» committed — of a failed import, or «Переменные → Доступы» of a working site:
 * the variables of the new access replace those of the old one, and a description of a database
 * plan that holds one of the new values is taken back, as `setSiteEnv` does. After the commit,
 * not before: a replacement refused under its lock must not have overwritten the values of the
 * access that stays. Every write to Vault goes under the lock of the row of the site: a deletion
 * (FOR UPDATE) waits for them and then erases what their rows name, a site deleted before is
 * written nothing, and of two changes of one access only the one its reference still names
 * (`reference`) writes — a slower earlier one does not put its values over the later ones. A
 * failure is logged and leaves the variables as they were; the access itself is replaced either
 * way.
 */
export async function replaceAccessVariables(
  db: PrismaClient,
  secrets: SiteConnectionServices['secrets'],
  input: {
    siteId: string
    userId: string
    siteUrl: string
    prepared: PreparedAccess<unknown>
    /** The kind of the access replaced; null — the site had none. */
    previousAccessKind: string | null
    /** The reference the change committed, at the version it wrote. */
    reference?: { vaultPath: string; version: number }
    now: Date
  },
): Promise<void> {
  const budget = deadline(siteConnectionLimits.checkMs)
  try {
    const variables = accessVariablesOf(input.siteUrl, [input.prepared])
    const stale = replacedVariableNames(
      input.previousAccessKind,
      input.prepared.accessKind,
      variables.map((variable) => variable.name),
    )
    await db.$transaction(
      async (tx) => {
        const [site] = await tx.$queryRaw<{ deleted: boolean; data_class: string }[]>`
          SELECT s.deleted_at IS NOT NULL AS deleted, w.data_class::text AS data_class
          FROM sites s JOIN workspaces w ON w.id = s.workspace_id
          WHERE s.id = ${input.siteId}::uuid
          FOR NO KEY UPDATE OF s`
        // Deleted meanwhile: its secrets were erased, and none of these is written.
        if (!site || site.deleted) return
        if (input.reference) {
          const ref = await tx.credentialRef.findUnique({
            where: { vaultPath: input.reference.vaultPath },
            select: { keyVersion: true },
          })
          // A later change of the same access committed: its own variables follow it.
          if (ref?.keyVersion !== input.reference.version) return
        }
        const written = await writeAccessVariables(secrets, {
          siteId: input.siteId,
          variables,
          signal: budget.signal,
        })
        await recordAccessVariables(tx, {
          siteId: input.siteId,
          userId: input.userId,
          dataClass: site.data_class === 'synthetic' ? 'synthetic' : 'client',
          written,
          now: input.now,
        })
        if (stale.length > 0)
          await tx.siteEnvVar.deleteMany({ where: { siteId: input.siteId, name: { in: stale } } })
        await eraseReplacedVariables(secrets, {
          siteId: input.siteId,
          names: stale,
          now: input.now,
          signal: budget.signal,
        })
        await takeBackDescriptions(
          tx,
          input.siteId,
          variables.map((variable) => variable.value),
        )
      },
      // The writes to Vault under the lock fit the budget of one check.
      { timeout: siteConnectionLimits.checkMs },
    )
  } catch (error) {
    console.warn(`site_access_variables_failed site=${input.siteId} ${failureLabel(error)}`)
  } finally {
    budget.end()
  }
}
