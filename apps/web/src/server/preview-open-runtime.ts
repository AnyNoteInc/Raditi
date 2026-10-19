import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'
import { throttledLogger } from '@repo/observability'
import { createCaller, createContext, openPreview } from '@repo/trpc'

import { env } from '@/env'

import type { PreviewOpenDependencies } from './preview-open'

export const previewOpenDependencies: PreviewOpenDependencies = {
  preview: () => env.web().preview,
  getSession: getSessionFromHeaders,
  async hasRequiredConsents(headers) {
    // The same answer the cabinet layout uses (lib/access.ts).
    const consents = await createCaller(await createContext({ headers })).consent.list()
    return consents.every((consent) => !consent.required || consent.accepted)
  },
  open: ({ userId, hostname, to }) =>
    openPreview(prisma, env.web().preview, { userId, target: { hostname }, to }),
  // A broken database is logged once per operation and minute: a reloading iframe cannot flood.
  onFailure: throttledLogger((line) => console.error(`[preview] ${line}`)),
}
