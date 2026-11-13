import { createHash } from 'node:crypto'

import { insertFeedEvent, type PrismaClient } from '@repo/db'
import {
  chatFileKey,
  isDomainError,
  type FeedFileLeftReason,
  type ObjectStorage,
} from '@repo/domain'
import { readOutboxArchive } from '@repo/snapshots'

import type { FileReservation, PagePublications } from './page-publications.ts'

// The files the agent made for the client in a completed turn (docs/plan/66-chat-visuals.md,
// В8–В10): the outbox the turn's capture took, read again here, each file put into the artifacts
// bucket under the chat and named by a `feed.file` row after the turn's answer. Web serves it
// only to a member of the chat (GET /api/tasks/<taskId>/files/<fileId>). The agent's answer may
// say a file is attached that never came, so whatever was left — by the capture, by a refusal,
// by a failed upload — is told to the client by a `feed.file_left` row after the files.

export interface ChatFilesDependencies {
  db: Pick<PrismaClient, 'taskTurn' | 'taskEvent'>
  storage: Pick<ObjectStorage, 'put'>
  /**
   * The pages of the turn (docs/plan/69-pages.md, Ст6): a file a reservation names becomes the
   * next version of its page instead of a file of the chat. Absent — no pages configured.
   */
  pages?: PagePublications
  logger?: { log(message: string): void; warn(message: string): void }
}

/**
 * The id of a file of a turn: the same for the same chat, turn and name, so that a delivery
 * repeated after a crash finds the row it wrote and writes no second one. A UUID of version 8.
 */
export function chatFileId(taskId: string, turn: number, name: string): string {
  const bytes = createHash('sha256')
    .update(`raditi-chat-file\0${taskId.toLowerCase()}\0${turn}\0${name}`, 'utf8')
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x80
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class ChatFiles {
  readonly #deps: ChatFilesDependencies

  constructor(deps: ChatFilesDependencies) {
    this.#deps = deps
  }

  /**
   * Puts every file of `outbox` and writes its row; returns how many rows it wrote. Never
   * throws: a file that did not reach the chat is a line in the log and a row that tells the
   * client, the turn stays done. `outbox` null — the turn left no files: only its pages, if it
   * named any, are told to have come to nothing.
   */
  async deliver(input: {
    taskId: string
    turn: number
    outbox: Uint8Array | null
  }): Promise<number> {
    const { db, storage, logger, pages } = this.#deps
    const { taskId, turn } = input
    let written = 0
    let turnId: string | null = null
    let reserved = new Map<string, FileReservation>()
    const seen = new Set<string>()
    try {
      const turnRow = await db.taskTurn.findFirst({
        where: { taskId, turnNo: turn },
        select: { id: true },
      })
      turnId = turnRow?.id ?? null
      reserved = pages ? await pages.filesOf(taskId, turn) : new Map()
      if (input.outbox === null) {
        for (const reservation of reserved.values())
          await pages!.left(reservation, 'missing', { taskId, turnId })
        return 0
      }
      const contents = await readOutboxArchive(input.outbox, {
        onFile: async (file) => {
          const reservation = reserved.get(file.name)
          if (reservation && pages) {
            seen.add(file.name)
            // A file the pages took is the page's; one they cannot draw yet goes on as a file.
            if (await pages.publish(reservation, file.bytes, { taskId, turn, turnId })) return
          }
          const fileId = chatFileId(taskId, turn, file.name)
          const known = await db.taskEvent.findFirst({
            where: { taskId, type: 'feed.file', payload: { path: ['fileId'], equals: fileId } },
            select: { id: true },
          })
          if (known) return
          await storage.put('artifacts', chatFileKey(taskId, fileId), file.bytes, {
            contentType: 'application/octet-stream',
            sizeBytes: file.sizeBytes,
          })
          await insertFeedEvent(db, {
            taskId,
            turnId,
            row: {
              type: 'feed.file',
              payload: { v: 1, fileId, name: file.name, sizeBytes: file.sizeBytes },
            },
          })
          written += 1
        },
      })
      if (written > 0)
        logger?.log(`chat_files_delivered task=${taskId} turn=${turn} files=${written}`)
      for (const [name, reservation] of reserved)
        if (!seen.has(name))
          await pages!.left(reservation, contents.refused ? 'refused' : 'missing', {
            taskId,
            turnId,
          })
      if (contents.refused) await this.#left(taskId, turnId, 'refused', 0)
      else if (contents.skipped > 0) await this.#left(taskId, turnId, 'skipped', contents.skipped)
    } catch (error) {
      const reason = isDomainError(error) ? error.code : 'unknown'
      logger?.warn(
        `chat_files_failed task=${taskId} turn=${turn} delivered=${written} reason=${reason}`,
      )
      for (const [name, reservation] of reserved)
        if (!seen.has(name)) await pages!.left(reservation, 'failed', { taskId, turnId })
      await this.#left(taskId, turnId, written > 0 ? 'skipped' : 'refused', 0)
    }
    return written
  }

  /** The pages a failed or cancelled turn named: told at once. Never throws. */
  async failPages(taskId: string, turn: number): Promise<void> {
    const { db, pages } = this.#deps
    if (!pages) return
    const turnRow = await db.taskTurn
      .findFirst({ where: { taskId, turnNo: turn }, select: { id: true } })
      .catch(() => null)
    await pages.failTurn(taskId, turn, turnRow?.id ?? null)
  }

  /** The row that says not all the files came: one a turn, whoever asks, and never a throw. */
  async #left(
    taskId: string,
    turnId: string | null,
    reason: FeedFileLeftReason,
    count: number,
  ): Promise<void> {
    const { db, logger } = this.#deps
    try {
      const known = await db.taskEvent.findFirst({
        where: { taskId, type: 'feed.file_left', ...(turnId ? { turnId } : {}) },
        select: { id: true },
      })
      if (known) return
      await insertFeedEvent(db, {
        taskId,
        turnId,
        row: { type: 'feed.file_left', payload: { v: 1, reason, count } },
      })
    } catch {
      logger?.warn(`chat_files_left_failed task=${taskId} reason=${reason}`)
    }
  }
}
