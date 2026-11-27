import {
  accountSkillLimits,
  isDomainError,
  isSkillJunk,
  joinRepoPath,
  marketplaceInvalid,
  marketplacePlugins,
  MARKETPLACE_FILES,
  skillFileExecutable,
  skillInvalid,
  skillSourceNotFound,
  SKILL_MD,
  type SkillFileEntry,
  type SkillRepoRef,
} from '@repo/domain'

import { MARKETPLACE_FILE_BYTES, type RepoReaders, type RepoTreeFile } from './repo.ts'
import { parseSkillMd, readSkillVersion, type SkillVersion } from './skill-md.ts'

// Skills of public repositories and marketplaces (docs/plan/97-skills.md, Нв7, Нв8, Нв10): which
// skills a folder of a repository holds, one of them read whole at a fixed commit, and the
// catalog a marketplace makes of its plugins.

/** A skill found in a repository: its folder, and its name and description when they were read. */
export interface FoundSkill {
  /** The folder inside the repository, `SKILL.md` in it. */
  path: string
  name: string
  description?: string
}

/** The folders under `root` with a `SKILL.md`, at most `scanDepth` below it, outside the junk. */
export function skillFolders(tree: readonly RepoTreeFile[], root: string): string[] {
  const prefix = root ? `${root}/` : ''
  const folders: string[] = []
  for (const file of tree) {
    if (!file.path.startsWith(prefix) && root !== '' && file.path !== `${root}/${SKILL_MD}`)
      continue
    if (file.path !== SKILL_MD && !file.path.endsWith(`/${SKILL_MD}`)) continue
    if (isSkillJunk(file.path)) continue
    const folder = file.path === SKILL_MD ? '' : file.path.slice(0, -(SKILL_MD.length + 1))
    if (root !== '' && folder !== root && !folder.startsWith(prefix)) continue
    const depth = (root === '' ? folder : folder.slice(root.length))
      .split('/')
      .filter(Boolean).length
    if (depth <= accountSkillLimits.scanDepth) folders.push(folder)
  }
  return folders.sort()
}

/** The last part of a path: the name a skill's folder gives it. */
const folderName = (path: string) => path.split('/').at(-1) ?? ''

export class SkillSources {
  readonly readers: RepoReaders

  constructor(readers: RepoReaders) {
    this.readers = readers
  }

  /** The commit a reference names now. */
  commit(ref: SkillRepoRef): Promise<string> {
    return this.readers[ref.host].commit(ref)
  }

  /**
   * The skills under the folder of `ref` at its commit now (Нв8): the folder itself when it holds
   * a `SKILL.md`, else every skill below it. Their names and descriptions are read for the
   * client to choose; a skill whose `SKILL.md` does not parse is listed by its folder.
   */
  async find(ref: SkillRepoRef): Promise<{ commit: string; skills: FoundSkill[] }> {
    const reader = this.readers[ref.host]
    const commit = await reader.commit(ref)
    const tree = await reader.tree(ref, commit)
    const folders = skillFolders(tree, ref.path)
    const own = folders.includes(ref.path) ? [ref.path] : folders
    if (own.length === 0) throw skillSourceNotFound()
    return { commit, skills: await this.#describe(ref, commit, own.slice(0, 100)) }
  }

  async #describe(ref: SkillRepoRef, commit: string, folders: readonly string[]) {
    const reader = this.readers[ref.host]
    return Promise.all(
      folders.map(async (path): Promise<FoundSkill> => {
        try {
          const bytes = await reader.file(
            ref,
            commit,
            joinRepoPath(path, SKILL_MD),
            accountSkillLimits.skillMdBytes,
          )
          const fields = parseSkillMd(new TextDecoder().decode(bytes))
          return { path, name: fields.name, description: fields.description }
        } catch (error) {
          if (!isDomainError(error)) throw error
          return { path, name: folderName(path) || ref.repo.split('/').at(-1)! }
        }
      }),
    )
  }

  /**
   * One skill whole: every file of its folder at `commit`, the junk left out, links refused,
   * within the bounds of a skill counted from the tree before a byte is read (Нв10).
   */
  async read(ref: SkillRepoRef, commit: string, folder: string): Promise<SkillVersion> {
    const reader = this.readers[ref.host]
    const tree = await reader.tree(ref, commit)
    const prefix = folder ? `${folder}/` : ''
    const own = tree.filter((file) => file.path.startsWith(prefix))
    const files: SkillFileEntry[] = []
    let declared = 0
    const kept = own.filter((file) => !isSkillJunk(file.path.slice(prefix.length)))
    if (kept.length > accountSkillLimits.filesPerSkill) throw skillInvalid('too_many_files')
    for (const file of kept) {
      const path = file.path.slice(prefix.length)
      if (file.mode === '120000') throw skillInvalid('link', path)
      if (file.mode === '160000') continue
      declared += file.size ?? 0
      if (declared > accountSkillLimits.skillBytes) throw skillInvalid('too_large')
    }
    // GitLab's tree has no sizes: the bound of the whole skill is kept as the bytes come too, and
    // no file is read past what is left of it.
    let read = 0
    for (const file of kept) {
      if (file.mode === '160000') continue
      const path = file.path.slice(prefix.length)
      const left = accountSkillLimits.skillBytes - read
      if (left <= 0) throw skillInvalid('too_large')
      const bytes = await reader
        .file(ref, commit, file.path, Math.min(accountSkillLimits.fileBytes, left))
        .catch((error: unknown) => {
          // Past what is left: the skill, not the source, is too large.
          if (
            isDomainError(error) &&
            error.code === 'SKILL_SOURCE_UNAVAILABLE' &&
            left < accountSkillLimits.fileBytes
          )
            throw skillInvalid('too_large')
          throw error
        })
      read += bytes.byteLength
      files.push({ path, bytes, executable: skillFileExecutable(path, file.mode === '100755') })
    }
    const name = folder ? folderName(folder) : undefined
    return readSkillVersion(files, name ? { folder: name } : {})
  }

  /**
   * The catalog of a marketplace (Нв7) at its commit now: its plugins the platform can read, each
   * with its skills — the folders it lists, or every `skills/<name>/SKILL.md` of its folder.
   * Skills of a plugin in another repository are found when it is opened (`find`).
   */
  async marketplace(home: SkillRepoRef): Promise<{
    commit: string
    name: string
    plugins: {
      name: string
      description?: string
      repo: SkillRepoRef
      skills: FoundSkill[] | null
    }[]
  }> {
    const reader = this.readers[home.host]
    const commit = await reader.commit(home)
    const tree = await reader.tree(home, commit)
    const file = MARKETPLACE_FILES.map((path) => joinRepoPath(home.path, path)).find((path) =>
      tree.some((entry) => entry.path === path),
    )
    if (!file) throw marketplaceInvalid()
    let data: unknown
    try {
      data = JSON.parse(
        new TextDecoder().decode(await reader.file(home, commit, file, MARKETPLACE_FILE_BYTES)),
      )
    } catch (error) {
      if (isDomainError(error) && error.code !== 'SKILL_SOURCE_NOT_FOUND') throw error
      throw marketplaceInvalid()
    }
    const name =
      typeof (data as { name?: unknown }).name === 'string'
        ? (data as { name: string }).name
        : home.repo
    const plugins = []
    let described = 0
    for (const plugin of marketplacePlugins(data, home)) {
      const sameRepo =
        plugin.repo.host === home.host &&
        plugin.repo.repo === home.repo &&
        (plugin.repo.ref === undefined || plugin.repo.ref === home.ref)
      if (!sameRepo) {
        plugins.push({ ...plugin, skills: null })
        continue
      }
      const folders = plugin.skillFolders
        ? plugin.skillFolders
            .map((folder) => joinRepoPath(plugin.repo.path, folder))
            .filter((folder) => tree.some((entry) => entry.path === joinRepoPath(folder, SKILL_MD)))
        : skillFolders(tree, joinRepoPath(plugin.repo.path, 'skills')).filter(
            (folder) =>
              folder.split('/').length ===
              joinRepoPath(plugin.repo.path, 'skills').split('/').filter(Boolean).length + 1,
          )
      // Every description is a request: at most 200 of a marketplace.
      const take = folders.slice(0, Math.max(0, 200 - described))
      described += take.length
      plugins.push({
        name: plugin.name,
        ...(plugin.description ? { description: plugin.description } : {}),
        repo: plugin.repo,
        skills: await this.#describe({ ...home, path: '' }, commit, take),
      })
    }
    return { commit, name, plugins }
  }
}
