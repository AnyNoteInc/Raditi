import { Logger, Module } from '@nestjs/common'
import { createMailer } from '@repo/mail'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { MAILER } from './notifications.tokens.ts'
import { NotificationsProcessor } from './notifications.processor.ts'

@Module({
  providers: [
    {
      provide: MAILER,
      useFactory: (config: CoreConfig) => {
        // Without SENDSAY_API_KEY (local development) letters go to this log.
        const logger = new Logger('Mail')
        return createMailer({
          ...config.mailer,
          logger: { info: (message) => logger.log(message) },
        })
      },
      inject: [CORE_CONFIG],
    },
    NotificationsProcessor,
  ],
})
export class NotificationsModule {}
