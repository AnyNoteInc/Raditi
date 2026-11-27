import { createHmac } from 'node:crypto'

import { Logger, Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { SecretStore } from '@repo/domain'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import { VkHttpApi } from '@repo/vk'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { notificationDeliveryOf } from '../tasks/notification-delivery.ts'
import { VkActions } from './vk-actions.ts'
import { VkNotify } from './vk-notify.ts'
import { VkProcessor } from './vk.processor.ts'
import { VK_ACTIONS, VK_NOTIFY } from './vk.tokens.ts'

/**
 * The publications in the VK communities of the workspaces (docs/plan/99-vk-community.md, §3.3):
 * the worker of the queue `vk`, the key of a community from Vault (`core-vk`) and the adapter
 * `@repo/vk`. A press runs only with a token core checks by VK_CONFIRM_SECRET.
 */
@Module({
  providers: [
    {
      provide: VK_ACTIONS,
      inject: [PRISMA, SECRET_STORE, CORE_CONFIG],
      useFactory: (prisma: PrismaClient, secrets: SecretStore, config: CoreConfig) => {
        const secret = config.vk.confirmSecret
        return new VkActions({
          db: prisma,
          secrets,
          api: new VkHttpApi(),
          mac: secret
            ? (material: string) =>
                createHmac('sha256', secret).update(material).digest('base64url')
            : null,
          logger: new Logger('VkActions'),
        })
      },
    },
    {
      // The notices of new comments (slice 99.6): by push and the bot, over chat_notifications.
      provide: VK_NOTIFY,
      inject: [PRISMA, CORE_CONFIG],
      useFactory: async (prisma: PrismaClient, config: CoreConfig) =>
        new VkNotify({ db: prisma, delivery: await notificationDeliveryOf(prisma, config) }),
    },
    VkProcessor,
  ],
  exports: [VK_ACTIONS],
})
export class VkModule {}
