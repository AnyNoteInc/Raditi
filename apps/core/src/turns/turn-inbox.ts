import { taskAttachment, type PrismaClient } from '@repo/db'
import {
  attachmentKey,
  attachmentLimits,
  conflict,
  turnInboxAttachmentId,
  turnInboxPath,
  type ObjectStorage,
  type TurnInboxFile,
} from '@repo/domain'

/** The files the plan of a turn names (`input.attachments`), as its executor reads them. */
export interface TurnInbox {
  files(taskId: string, paths: readonly string[]): Promise<TurnInboxFile[]>
}

/** Neither the key nor the name of a file reaches the error: the task and the path are enough. */
const notBound = () => conflict('A file of the turn is not bound to its task')

/**
 * The files of a turn with a repository from raditi-inbox (spec §8, «Подготовка»; §14): every
 * path is checked against the database again before any byte is read — bound to this very task,
 * at the path of its id and name, its key the one of its workspace, its size within the limit
 * of a file. Each is read when the executor takes it, so a turn holds one file at a time.
 */
export class TaskInboxFiles implements TurnInbox {
  constructor(
    private readonly db: Pick<PrismaClient, 'attachment'>,
    private readonly storage: Pick<ObjectStorage, 'get'>,
  ) {}

  async files(taskId: string, paths: readonly string[]): Promise<TurnInboxFile[]> {
    const files: TurnInboxFile[] = []
    for (const path of paths) {
      const id = turnInboxAttachmentId(path)
      const row = id === null ? null : await taskAttachment(this.db, { id, taskId })
      if (
        row === null ||
        turnInboxPath(row.id, row.fileName) !== path ||
        row.s3Key !== attachmentKey(row.workspaceId, row.id) ||
        row.sizeBytes < 1 ||
        row.sizeBytes > attachmentLimits.fileBytes
      )
        throw notBound()
      const key = row.s3Key
      files.push({ path, sizeBytes: row.sizeBytes, read: () => this.#read(key) })
    }
    return files
  }

  async *#read(key: string): AsyncIterable<Uint8Array> {
    const body = await this.storage.get('inbox', key)
    if (body === null) throw conflict('A file of the turn is missing from the inbox')
    yield* body
  }
}
