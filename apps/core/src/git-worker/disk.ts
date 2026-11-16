import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

// The size of a directory of the volume of the mirrors, never following a link: the quota of a
// fetch in the worker and the fill of the volume in core (docs/plan/84-projects.md, ПР12).

/** The bytes of the regular files below `path`, never following a link. */
export async function directoryBytes(path: string): Promise<number> {
  let total = 0
  const pending = [path]
  while (pending.length) {
    const dir = pending.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile()) total += (await lstat(child).catch(() => null))?.size ?? 0
    }
  }
  return total
}
