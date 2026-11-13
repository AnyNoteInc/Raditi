import 'server-only'

import { prisma } from '@repo/db'
import { throttledLogger } from '@repo/observability'
import { readPageView, readTaskFile } from '@repo/trpc'

import { chatServices } from './chat-services'
import type { PageViewDependencies } from './page-response'

const unavailable = () => {
  throw new Error('Dialogs are unavailable: their settings do not parse')
}

/** The domain of pages of this process, as the routes of its host read it. */
export function pagesOfProcess() {
  const pages = chatServices()?.pages ?? null
  if (pages === null) return null
  return {
    host: new URL(pages.origin).host.toLowerCase(),
    appOrigin: new URL(pages.appUrl).origin,
    viewKey: pages.keys.view,
    shareKey: pages.keys.share,
    sharing: pages.sharing,
  }
}

export const pageLog = throttledLogger((line) => console.error(`[pages] ${line}`))

export const pageViewDependencies: PageViewDependencies = {
  pages: pagesOfProcess,
  readView: readPageView,
  read: (input) => readTaskFile(prisma, (chatServices() ?? unavailable()).storage(), input),
  onFailure: pageLog,
}
