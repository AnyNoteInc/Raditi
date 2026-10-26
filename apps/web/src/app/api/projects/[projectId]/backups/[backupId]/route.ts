import { getSiteBackup } from '@/server/site-backup'
import { siteBackupDependencies } from '@/server/site-backup-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** «Скачать» of a copy in «База и бэкап»: the tar.gz of the site's files. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; backupId: string }> },
): Promise<Response> {
  return getSiteBackup(request, await params, siteBackupDependencies)
}
