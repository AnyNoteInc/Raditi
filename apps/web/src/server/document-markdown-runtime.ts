import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'
import { throttledLogger } from '@repo/observability'
import { cabinetDocMarkdown, createCaller, createContext } from '@repo/trpc'

import type { DocumentMarkdownDependencies } from './document-markdown'

export const documentMarkdownDependencies: DocumentMarkdownDependencies = {
  getSession: getSessionFromHeaders,
  async hasRequiredConsents(headers) {
    // The same answer the cabinet layout uses (lib/access.ts).
    const consents = await createCaller(await createContext({ headers })).consent.list()
    return consents.every((consent) => !consent.required || consent.accepted)
  },
  read: (input) => cabinetDocMarkdown(prisma, input),
  onFailure: throttledLogger((line) => console.error(`[documents] ${line}`)),
}
