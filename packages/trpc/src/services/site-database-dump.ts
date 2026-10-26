import type { PrismaClient } from '@repo/db'
import { databaseDumpPathSchema, DomainError } from '@repo/domain'

import { isManagerRole, memberRole } from './chat/access.ts'
import { accessibleSite, siteNotFound } from './site-basics.ts'

// The SQL dump of a site that a preview's database is copied from (owner's decision of
// 26.10.2026, «Из дампа в корне FTP»): the owner names a file of the site's file source; core
// reads it through the saved access when a preview is built (apps/core/src/previews). Web never
// reads the access and never opens the file: it records the name only.

export interface SiteDatabaseDumpView {
  /** Relative to the login folder of the file source; null — none is named. */
  path: string | null
  updatedAt: Date | null
  /** The site has a file source to read a dump through. */
  readable: boolean
  /** The site has a live database: it is copied, not the dump. */
  liveDatabase: boolean
}

export const siteDumpNotAllowed = () =>
  new DomainError(
    'SITE_DUMP_NOT_ALLOWED',
    'Only an owner or an admin names the dump of a site',
    403,
  )
export const siteDumpPathInvalid = () =>
  new DomainError('SITE_DUMP_PATH_INVALID', 'Not the path of a .sql or .sql.gz file', 400)
export const siteDumpUnreadable = () =>
  new DomainError(
    'SITE_DUMP_NO_FILE_SOURCE',
    'The site has no file source a dump could be read through',
    409,
  )

async function siteOf(db: PrismaClient, userId: string, siteId: string) {
  const site = await db.site.findFirst({
    where: accessibleSite(userId, siteId),
    select: {
      id: true,
      workspaceId: true,
      codeSource: { select: { kind: true } },
      database: { select: { siteId: true } },
      databaseDump: { select: { path: true, updatedAt: true } },
    },
  })
  if (!site) throw siteNotFound()
  return site
}

const viewOf = (site: Awaited<ReturnType<typeof siteOf>>): SiteDatabaseDumpView => ({
  path: site.databaseDump?.path ?? null,
  updatedAt: site.databaseDump?.updatedAt ?? null,
  // Only a source of files has a login folder: a repository of the client has none.
  readable: site.codeSource !== null && site.codeSource.kind !== 'git',
  liveDatabase: site.database !== null,
})

export async function readSiteDatabaseDump(
  db: PrismaClient,
  input: { userId: string; siteId: string },
): Promise<SiteDatabaseDumpView> {
  return viewOf(await siteOf(db, input.userId, input.siteId))
}

/** Names the dump of a site, or none (`path: null`); an owner or an admin only, audited. */
export async function setSiteDatabaseDump(
  db: PrismaClient,
  input: { userId: string; siteId: string; path: string | null; ip: string | null },
): Promise<SiteDatabaseDumpView> {
  const site = await siteOf(db, input.userId, input.siteId)
  if (!isManagerRole(await memberRole(db, site.workspaceId, input.userId)))
    throw siteDumpNotAllowed()
  const parsed = input.path === null ? null : databaseDumpPathSchema.safeParse(input.path)
  if (parsed && !parsed.success) throw siteDumpPathInvalid()
  const path = parsed?.data ?? null
  if (path !== null && !viewOf(site).readable) throw siteDumpUnreadable()
  await db.$transaction(async (tx) => {
    if (path === null) await tx.siteDatabaseDump.deleteMany({ where: { siteId: site.id } })
    else
      await tx.siteDatabaseDump.upsert({
        where: { siteId: site.id },
        create: { siteId: site.id, path },
        update: { path },
      })
    await tx.auditLog.create({
      data: {
        actorType: 'user',
        actorId: input.userId,
        workspaceId: site.workspaceId,
        action: path === null ? 'site.database_dump.clear' : 'site.database_dump.set',
        targetType: 'site',
        targetId: site.id,
        // The name of a file of the client's own hosting, never anything of its content.
        ...(path === null ? {} : { meta: { path } }),
        ip: input.ip,
      },
    })
  })
  return readSiteDatabaseDump(db, input)
}
