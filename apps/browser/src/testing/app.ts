// The browser worker app as startBrowser makes it, with stand-ins for what a test does not run:
// the database, the store, the containers, the browser, the inbox. Only for *.test.ts files
// (excluded from the build).
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import type { PrismaClient } from '@repo/db'
import type { BrowserSessionRuntime, CloudBrowserFactory } from '@repo/domain'
import { PRISMA } from '@repo/service-runtime'
import { fakeInfra } from '@repo/service-runtime/testing/fakes'

import { AppModule } from '../app.module.ts'
import type { InboxStorage } from '../attachments/attachments.ts'
import { INBOX_STORAGE } from '../attachments/attachments.tokens.ts'
import type { BrowserWorkerConfig } from '../config/config.ts'
import { CLOUD_BROWSERS, SESSION_RUNTIME } from '../sessions/sessions.tokens.ts'
import { browserAppOptions, serveBrowser } from '../start.ts'
import { WORKER_STORE } from '../store/store.tokens.ts'
import type { BrowserWorkerStore } from '../store/worker-store.ts'

/** What stands in for the real thing; what is left out is the app's own. */
export interface BrowserStandIns {
  /** The Prisma client: /health asks it SELECT 1, PrismaLifecycle disconnects it (fakeInfra's). */
  prisma?: Pick<PrismaClient, '$queryRaw' | '$disconnect'>
  store?: BrowserWorkerStore
  runtime?: BrowserSessionRuntime | null
  browsers?: CloudBrowserFactory
  inbox?: InboxStorage
}

/** startBrowser on AppModule with the stand-ins in place of its providers; it listens. */
export async function startTestBrowser(
  config: BrowserWorkerConfig,
  standIns: BrowserStandIns = {},
): Promise<NestExpressApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(PRISMA)
    .useValue(standIns.prisma ?? fakeInfra().prisma)
  if (standIns.store) builder.overrideProvider(WORKER_STORE).useValue(standIns.store)
  if (standIns.runtime !== undefined)
    builder.overrideProvider(SESSION_RUNTIME).useValue(standIns.runtime)
  if (standIns.browsers) builder.overrideProvider(CLOUD_BROWSERS).useValue(standIns.browsers)
  if (standIns.inbox) builder.overrideProvider(INBOX_STORAGE).useValue(standIns.inbox)
  const module = await builder.compile()
  return serveBrowser(
    module.createNestApplication<NestExpressApplication>(browserAppOptions(config)),
    config,
  )
}
