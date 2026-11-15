import { chatProjectFile, type PrismaClient } from '@repo/db'
import {
  conflict,
  projectFileKey,
  projectLimits,
  turnProjectFileName,
  type ObjectStorage,
  type TurnInboxFile,
} from '@repo/domain'

/** The files of its project a plan of a turn names (`input.projectFiles`), as its executor reads them. */
export interface TurnProjectFiles {
  files(taskId: string, paths: readonly string[]): Promise<TurnInboxFile[]>
}

/** Neither the key nor the name of a file reaches the error: the task is enough. */
const notOfTheChat = () => conflict('A file of the turn is not a file of the project of its chat')

/**
 * The files of the context of the chat's project (docs/plan/84-projects.md, ПР8; slice 84.9), from
 * raditi-inbox — TaskInboxFiles of a second root. Every path is checked against the database again
 * before any byte is read: a ready file of the project the chat is in now (not the one the plan was
 * made for, if the chat moved since: ПР2), at its path, its key the one of its workspace, its size
 * within the limit of a file. Each is read when the executor takes it.
 */
export class TaskProjectFiles implements TurnProjectFiles {
  constructor(
    private readonly db: Pick<PrismaClient, 'task'>,
    private readonly storage: Pick<ObjectStorage, 'get'>,
  ) {}

  async files(taskId: string, paths: readonly string[]): Promise<TurnInboxFile[]> {
    const files: TurnInboxFile[] = []
    for (const path of paths) {
      const name = turnProjectFileName(path)
      const row = name === null ? null : await chatProjectFile(this.db, { taskId, name })
      if (
        row === null ||
        row.name !== name ||
        row.key !== projectFileKey(row.workspaceId, row.id) ||
        row.sizeBytes < 1 ||
        row.sizeBytes > projectLimits.fileBytes
      )
        throw notOfTheChat()
      const key = row.key
      files.push({ path, sizeBytes: row.sizeBytes, read: () => this.#read(key) })
    }
    return files
  }

  async *#read(key: string): AsyncIterable<Uint8Array> {
    const body = await this.storage.get('inbox', key)
    if (body === null) throw conflict('A file of the project is missing from the inbox')
    yield* body
  }
}
