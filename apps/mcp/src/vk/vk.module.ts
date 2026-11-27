import { Module } from '@nestjs/common'
import {
  reserveVkProposal,
  workingVkCommunities,
  workingVkCommunity,
  type PrismaClient,
} from '@repo/db'
import type { SecretStore } from '@repo/domain'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import { VkHttpApi } from '@repo/vk'

import { McpVkController } from './mcp-vk.controller.ts'
import { McpVkService, type McpVkStore } from './vk-service.ts'
import { VkServiceKey } from './vk-service-key.ts'
import { MCP_VK } from './vk.tokens.ts'

/** The store of the communities: rows of the role's database only, never a key. */
export function postgresVkStore(db: PrismaClient): McpVkStore {
  return {
    communities: (workspaceId) => workingVkCommunities(db, workspaceId),
    community: (workspaceId, communityId) => workingVkCommunity(db, workspaceId, communityId),
    reserve: (input) => reserveVkProposal(db, input),
  }
}

/**
 * The built-in server «ВКонтакте» (docs/plan/99-vk-community.md, ВК1, ВК15): the family `vk`,
 * offered to a turn whose workspace has it on. It reads open walls by the service key of Raditi's
 * app (Vault `subs/vk/service`) and reserves proposals; the key of a client's community is
 * never read here — core publishes after the client's button.
 */
@Module({
  controllers: [McpVkController],
  providers: [
    {
      provide: MCP_VK,
      inject: [PRISMA, SECRET_STORE],
      useFactory: (prisma: PrismaClient, secrets: SecretStore) =>
        new McpVkService({
          store: postgresVkStore(prisma),
          api: new VkHttpApi(),
          serviceKey: new VkServiceKey(secrets),
        }),
    },
  ],
})
export class VkModule {}
