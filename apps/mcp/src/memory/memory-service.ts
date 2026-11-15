import type { ChatMemory, ListedMemoryEntry, MemoryScope } from '@repo/db'
import {
  isDomainError,
  memoryForgetArgumentsSchema,
  memoryListArgumentsSchema,
  memorySaveArgumentsSchema,
  memoryUpdateArgumentsSchema,
  type MemoryChangeRequest,
} from '@repo/domain'

import type { McpTurnAccess } from '../access/mcp-access.ts'

/**
 * The memory of a chat for the agent (docs/plan/84-projects.md, ПР18, §4.4): in a chat of a project
 * the project's, without one the account's — of the author of the chat, while «Агент запоминает
 * важное» is on. `memory_list` answers at once; `memory_save`, `memory_update` and `memory_forget`
 * are checked now and reserved, and core applies them when the pass completed — only core knows
 * the client's words of the pass, what came in from outside and the values of the client, and so
 * whether a note is active at once or «Предложено». Which memory comes from the admitted turn, never
 * from the arguments.
 */
export interface McpMemoryStore {
  /** The memory of the chat now; null — off. */
  memory(taskId: string): Promise<ChatMemory | null>
  list(memory: ChatMemory): Promise<ListedMemoryEntry[]>
  reserve(input: {
    taskId: string
    turnNo: number
    scope: MemoryScope
    change: MemoryChangeRequest
  }): Promise<{ reservationId: string }>
}

export type McpMemoryAnswer =
  { ok: true; value: unknown } | { ok: false; code: string; message: string }

const refusal = (error: unknown): McpMemoryAnswer => {
  if (isDomainError(error)) return { ok: false, code: error.code, message: error.message }
  throw error
}
const badRequest = (message: string): McpMemoryAnswer => ({
  ok: false,
  code: 'BAD_REQUEST',
  message,
})
const off: McpMemoryAnswer = {
  ok: false,
  code: 'MEMORY_OFF',
  message: 'The memory of this chat is off: the client turned it off',
}

const reserved = (reservationId: string) => ({
  ok: true as const,
  value: {
    ok: true,
    reservedId: reservationId,
    live: 'when this turn ends',
    status:
      'active only when the client asked to remember it in this turn and nothing of outside came into it; otherwise the client confirms it',
  },
})

export class McpMemoryService {
  readonly #store: McpMemoryStore

  constructor(deps: { store: McpMemoryStore }) {
    this.#store = deps.store
  }

  /** The memory of the turn: what the admission found, and the chat's still. */
  async #scope(access: McpTurnAccess): Promise<ChatMemory | null> {
    if (!access.memory) return null
    const memory = await this.#store.memory(access.taskId)
    if (
      !memory ||
      memory.userId !== access.memory.userId ||
      memory.projectId !== access.memory.projectId ||
      memory.workspaceId !== access.workspaceId
    )
      return null
    return memory
  }

  async list(access: McpTurnAccess, args: unknown = {}): Promise<McpMemoryAnswer> {
    if (!memoryListArgumentsSchema.safeParse(args ?? {}).success) return badRequest('No arguments')
    try {
      const memory = await this.#scope(access)
      if (!memory) return off
      const entries = await this.#store.list(memory)
      return {
        ok: true,
        value: {
          entries: entries.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            text: entry.text,
            status: entry.status,
            author: entry.author,
            version: entry.version,
            memory: entry.projectId === null ? 'account' : 'project',
            ...(entry.pendingAction ? { pending: entry.pendingAction } : {}),
            updatedAt: entry.updatedAt.toISOString(),
          })),
        },
      }
    } catch (error) {
      return refusal(error)
    }
  }

  async save(access: McpTurnAccess, args: unknown): Promise<McpMemoryAnswer> {
    const parsed = memorySaveArgumentsSchema.safeParse(args)
    if (!parsed.success) return badRequest('Give kind and text of 1 to 400 characters')
    return this.#reserve(access, {
      kind: 'save',
      entryKind: parsed.data.kind,
      text: parsed.data.text,
    })
  }

  async update(access: McpTurnAccess, args: unknown): Promise<McpMemoryAnswer> {
    const parsed = memoryUpdateArgumentsSchema.safeParse(args)
    if (!parsed.success)
      return badRequest('Give id, text of 1 to 400 characters and expectedVersion')
    return this.#reserve(access, {
      kind: 'update',
      entryId: parsed.data.id,
      text: parsed.data.text,
      expectedVersion: parsed.data.expectedVersion,
    })
  }

  async forget(access: McpTurnAccess, args: unknown): Promise<McpMemoryAnswer> {
    const parsed = memoryForgetArgumentsSchema.safeParse(args)
    if (!parsed.success) return badRequest('Give id and expectedVersion')
    return this.#reserve(access, {
      kind: 'forget',
      entryId: parsed.data.id,
      expectedVersion: parsed.data.expectedVersion,
    })
  }

  async #reserve(access: McpTurnAccess, change: MemoryChangeRequest): Promise<McpMemoryAnswer> {
    try {
      const memory = await this.#scope(access)
      if (!memory) return off
      const { reservationId } = await this.#store.reserve({
        taskId: access.taskId,
        turnNo: access.turn,
        scope: {
          workspaceId: memory.workspaceId,
          userId: memory.userId,
          projectId: memory.projectId,
        },
        change,
      })
      return reserved(reservationId)
    } catch (error) {
      return refusal(error)
    }
  }
}
