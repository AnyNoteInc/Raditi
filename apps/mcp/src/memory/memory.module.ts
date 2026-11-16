import { Module } from '@nestjs/common'
import { chatMemory, listChatMemory, reserveMemoryChange, type PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime'

import { McpMemoryController } from './mcp-memory.controller.ts'
import { McpMemoryService, type McpMemoryStore } from './memory-service.ts'
import { MCP_MEMORY } from './memory.tokens.ts'

/** The store of the memory: the functions of @repo/db over the role's database. */
export function postgresMemoryStore(db: PrismaClient): McpMemoryStore {
  return {
    memory: (taskId) => chatMemory(db, taskId),
    list: (memory) => listChatMemory(db, memory),
    reserve: (input) => reserveMemoryChange(db, input),
  }
}

/**
 * The memory of a chat (docs/plan/84-projects.md, ПР18): no profile and no configuration — every
 * composition has it; a turn is offered it while the memory of its chat is on.
 */
@Module({
  controllers: [McpMemoryController],
  providers: [
    {
      provide: MCP_MEMORY,
      inject: [PRISMA],
      useFactory: (prisma: PrismaClient) =>
        new McpMemoryService({ store: postgresMemoryStore(prisma) }),
    },
  ],
})
export class MemoryModule {}
