import { Module } from '@nestjs/common'
import type { Registry } from '@prometheus-io/client'
import type { BrowserSessionRuntime, CloudBrowserFactory } from '@repo/domain'
import { getSiteAdapter } from '@repo/site-adapters'

import type { InboxStorage } from '../attachments/attachments.ts'
import { AttachmentsModule } from '../attachments/attachments.module.ts'
import { INBOX_STORAGE } from '../attachments/attachments.tokens.ts'
import type { BrowserWorkerConfig } from '../config/config.ts'
import { BROWSER_CONFIG } from '../config/config.module.ts'
import { METRICS_REGISTRY } from '../metrics/metrics.tokens.ts'
import { SessionManager } from '../sessions/session-manager.ts'
import { SessionsModule } from '../sessions/sessions.module.ts'
import { CLOUD_BROWSERS, SESSION_RUNTIME } from '../sessions/sessions.tokens.ts'
import { StoreModule } from '../store/store.module.ts'
import { WORKER_STORE } from '../store/store.tokens.ts'
import type { BrowserWorkerStore } from '../store/worker-store.ts'
import { BrowserWorker } from './browser-worker.ts'

/**
 * The worker as one piece (BrowserWorker): its sessions, their stream on the app's HTTP server
 * and their metrics, with the sweep of idle and expired sessions and the close of every session
 * when the app stops. The API reaches the sessions through SessionManager, the one export.
 */
@Module({
  imports: [StoreModule, AttachmentsModule, SessionsModule],
  providers: [
    {
      provide: BrowserWorker,
      useFactory: (
        config: BrowserWorkerConfig,
        store: BrowserWorkerStore,
        runtime: BrowserSessionRuntime | null,
        browsers: CloudBrowserFactory,
        inbox: InboxStorage,
        registry: Registry,
      ) =>
        new BrowserWorker({
          config,
          store,
          runtime,
          browsers,
          inbox,
          // The stack of the site picks its policy; this module names no CMS.
          adapters: getSiteAdapter,
          registry,
        }),
      inject: [
        BROWSER_CONFIG,
        WORKER_STORE,
        SESSION_RUNTIME,
        CLOUD_BROWSERS,
        INBOX_STORAGE,
        METRICS_REGISTRY,
      ],
    },
    {
      provide: SessionManager,
      useFactory: (worker: BrowserWorker) => worker.sessions,
      inject: [BrowserWorker],
    },
  ],
  exports: [SessionManager],
})
export class WorkerModule {}
