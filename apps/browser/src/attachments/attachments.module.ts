import { Module } from '@nestjs/common'

import type { BrowserWorkerConfig } from '../config/config.ts'
import { BROWSER_CONFIG } from '../config/config.module.ts'
import { createInboxStorage, type InboxStorage } from './attachments.ts'
import { INBOX_STORAGE } from './attachments.tokens.ts'

/** The attachments of tasks: the inbox bucket and nothing else of S3 (Б26, spec §14). */
@Module({
  providers: [
    {
      provide: INBOX_STORAGE,
      useFactory: (config: BrowserWorkerConfig): InboxStorage => createInboxStorage(config.storage),
      inject: [BROWSER_CONFIG],
    },
  ],
  exports: [INBOX_STORAGE],
})
export class AttachmentsModule {}
