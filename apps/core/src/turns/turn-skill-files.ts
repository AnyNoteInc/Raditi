import { chatAccountSkillVersions, type PrismaClient } from '@repo/db'
import {
  accountSkillFileKey,
  accountSkillLimits,
  conflict,
  turnSkillFileOf,
  type ObjectStorage,
  type TurnSkillFile,
} from '@repo/domain'

/** The files of the skills a plan of a turn names (`input.skillFiles`), as its executor reads them. */
export interface TurnSkillFiles {
  files(taskId: string, paths: readonly string[]): Promise<TurnSkillFile[]>
}

/**
 * The files of the skills of the author of a chat (docs/plan/97-skills.md, Нв13), from
 * raditi-inbox — TaskProjectFiles of a third root. The paths are checked against the database
 * again, once for the turn, before any byte is read: an enabled skill of the author of the chat
 * now, its current version, the file at that path, within the bound of a file. A skill the client
 * turned off or changed since the plan was made is left out, file by file: the turn goes on
 * without it.
 */
export class TaskSkillFiles implements TurnSkillFiles {
  readonly #db: Pick<PrismaClient, 'task' | 'accountSkill'>
  readonly #storage: Pick<ObjectStorage, 'get'>

  constructor(
    db: Pick<PrismaClient, 'task' | 'accountSkill'>,
    storage: Pick<ObjectStorage, 'get'>,
  ) {
    this.#db = db
    this.#storage = storage
  }

  async files(taskId: string, paths: readonly string[]): Promise<TurnSkillFile[]> {
    const places = paths.map((sandboxPath) => {
      const place = turnSkillFileOf(sandboxPath)
      if (place === null) throw conflict('A file of the turn is not a file of a skill')
      return { sandboxPath, name: place.name, inner: place.path }
    })
    if (places.length === 0) return []
    const owned = await chatAccountSkillVersions(this.#db, taskId)
    if (owned === null) return []
    const files: TurnSkillFile[] = []
    for (const place of places) {
      const skill = owned.skills.get(place.name)
      const index = skill?.files.findIndex((file) => file.path === place.inner) ?? -1
      if (!skill || index < 0) continue
      const file = skill.files[index]!
      if (file.sizeBytes < 0 || file.sizeBytes > accountSkillLimits.fileBytes)
        throw conflict('A file of a skill is out of its bounds')
      const key = accountSkillFileKey(owned.userId, skill.versionId, index)
      files.push({
        path: place.sandboxPath,
        sizeBytes: file.sizeBytes,
        executable: file.executable,
        read: () => this.#read(key),
      })
    }
    return files
  }

  async *#read(key: string): AsyncIterable<Uint8Array> {
    const body = await this.#storage.get('inbox', key)
    if (body === null) throw conflict('A file of a skill is missing from the inbox')
    yield* body
  }
}
