// The files of a unified diff of git and their counts (docs/plan/84-projects.md, ПР26): the card
// «Изменения в ветке» and the card of the build settings (ПР16) count them alike.

/** One changed file of a unified diff of git: its path and counts (binary — 0 and 0). */
export interface DiffFileStat {
  path: string
  additions: number
  deletions: number
}

/** The files of a patch of `git diff` and their counts, in its order. */
export function diffStat(patch: Uint8Array): DiffFileStat[] {
  const text = Buffer.from(patch).toString('utf8')
  const files: DiffFileStat[] = []
  let current: DiffFileStat | null = null
  let inHunk = false
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      current = { path: match?.[2] ?? line.slice(11), additions: 0, deletions: 0 }
      files.push(current)
      inHunk = false
      continue
    }
    if (!current) continue
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) current.additions += 1
    else if (line.startsWith('-')) current.deletions += 1
  }
  return files
}
