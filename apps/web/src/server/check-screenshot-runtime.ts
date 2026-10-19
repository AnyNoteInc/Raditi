import 'server-only'

import { getSessionFromHeaders } from '@repo/auth'
import { prisma } from '@repo/db'
import { throttledLogger } from '@repo/observability'
import { createCaller, createContext, readCheckScreenshot } from '@repo/trpc'

import type { CheckScreenshotDependencies } from './check-screenshot'
import { chatServices } from './chat-services'

const unavailable = () => {
  throw new Error('Dialogs are unavailable: their settings do not parse')
}

export const checkScreenshotDependencies: CheckScreenshotDependencies = {
  getSession: getSessionFromHeaders,
  async hasRequiredConsents(headers) {
    // The same answer the cabinet layout uses (lib/access.ts).
    const consents = await createCaller(await createContext({ headers })).consent.list()
    return consents.every((consent) => !consent.required || consent.accepted)
  },
  read: (input) => readCheckScreenshot(prisma, (chatServices() ?? unavailable()).storage(), input),
  onFailure: throttledLogger((line) => console.error(`[chat] ${line}`)),
}
