import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

// The size of a directory of the volume of the mirrors, never following a link: the quota of a
// fetch in the worker and the fill of the volume in core (docs/plan/84-projects.md, ПР12).

/** Directories listed and files measured at once: a pack directory holds thousands of files. */
const WALK_CONCURRENCY = 32

/** The bytes of the regular files below `path`, never following a link. */
export async function directoryBytes(path: string): Promise<number> {
  let total = 0
  const pending = [path]
  while (pending.length) {
    const listed = await Promise.all(
      pending.splice(0, WALK_CONCURRENCY).map((dir) =>
        readdir(dir, { withFileTypes: true }).then(
          (entries) => entries.map((entry) => ({ entry, path: join(dir, entry.name) })),
          () => [],
        ),
      ),
    )
    const files: string[] = []
    for (const { entry, path: child } of listed.flat()) {
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile()) files.push(child)
    }
    for (let at = 0; at < files.length; at += WALK_CONCURRENCY) {
      const sizes = await Promise.all(
        files.slice(at, at + WALK_CONCURRENCY).map((file) =>
          lstat(file).then(
            (info) => info.size,
            () => 0,
          ),
        ),
      )
      for (const size of sizes) total += size
    }
  }
  return total
}
