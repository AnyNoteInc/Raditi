import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'
import { throttledLogger } from '@repo/observability'
import { createCaller, createContext, readTaskFile } from '@repo/trpc'

import { chatServices } from './chat-services'
import type { TaskFileDependencies } from './task-file'

const unavailable = () => {
  throw new Error('Dialogs are unavailable: their settings do not parse')
}

export const taskFileDependencies: TaskFileDependencies = {
  getSession: getSessionFromHeaders,
  async hasRequiredConsents(headers) {
    // The same answer the cabinet layout uses (lib/access.ts).
    const consents = await createCaller(await createContext({ headers })).consent.list()
    return consents.every((consent) => !consent.required || consent.accepted)
  },
  read: (input) => readTaskFile(prisma, (chatServices() ?? unavailable()).storage(), input),
  onFailure: throttledLogger((line) => console.error(`[chat] ${line}`)),
}
