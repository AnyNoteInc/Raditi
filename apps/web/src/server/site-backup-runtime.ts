import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'
import type { ObjectStorage } from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { createS3ObjectStorage } from '@repo/storage'
import { createCaller, createContext, readSiteBackupDownload } from '@repo/trpc'

import { env } from '@/env'

import type { SiteBackupDependencies } from './site-backup'

let storage: ObjectStorage | undefined

export const siteBackupDependencies: SiteBackupDependencies = {
  getSession: getSessionFromHeaders,
  async hasRequiredConsents(headers) {
    // The same answer the cabinet layout uses (lib/access.ts).
    const consents = await createCaller(await createContext({ headers })).consent.list()
    return consents.every((consent) => !consent.required || consent.accepted)
  },
  read: (input) =>
    readSiteBackupDownload(prisma, (storage ??= createS3ObjectStorage(env.storage())), input),
  onFailure: throttledLogger((line) => console.error(`[web] ${line}`)),
}
