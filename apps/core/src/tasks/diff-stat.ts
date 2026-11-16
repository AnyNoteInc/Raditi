// The files of a unified diff of git and their counts (docs/plan/84-projects.md, ПР26): the card
// «Изменения в ветке» and the card of the build settings (ПР16) count them alike.

/** One changed file of a unified diff of git: its path and counts (binary — 0 and 0). */
export interface DiffFileStat {
  path: string
  additions: number
  deletions: number
  /**
   * The header named no path this reads (ревью, безопасность 2): such a file counts as a change
   * of the build settings, never as an ordinary one.
   */
  unreadable?: true
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 }

/**
 * A path of a header as git writes it: plain, or quoted with C escapes and octal bytes when it
 * has bytes outside ASCII, a tab, a quote or a backslash (`core.quotePath`). null — not a path.
 */
function headerPath(text: string, prefix: 'a/' | 'b/'): string | null {
  if (!text.startsWith('"')) return text.startsWith(prefix) ? text.slice(2) : null
  if (!text.endsWith('"') || text.length < 2) return null
  const bytes: number[] = []
  const body = text.slice(1, -1)
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'))
      continue
    }
    const next = body[i + 1]
    if (next === undefined) return null
    if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{3}/.exec(body.slice(i + 1))
      if (!octal) return null
      bytes.push(Number.parseInt(octal[0], 8))
      i += 3
    } else if (next === '"' || next === '\\') {
      bytes.push(next.charCodeAt(0))
      i += 1
    } else {
      const escaped = ESCAPES[next]
      if (escaped === undefined) return null
      bytes.push(escaped)
      i += 1
    }
  }
  const path = Buffer.from(bytes).toString('utf8')
  return path.startsWith(prefix) ? path.slice(2) : null
}

/** The path of `diff --git <a> <b>`: the `b/` side, each side plain or quoted. */
function pathOfHeader(rest: string): string | null {
  const quoted = /^(?:"(?:[^"\\]|\\.)*"|a\/.+?) ("(?:[^"\\]|\\.)*")$/.exec(rest)
  if (quoted) return headerPath(quoted[1]!, 'b/')
  const plain = /^(?:"(?:[^"\\]|\\.)*"|a\/(.+)) b\/(.+)$/.exec(rest)
  if (plain) return plain[2]!
  return null
}

/** The files of a patch of `git diff` and their counts, in its order. */
export function diffStat(patch: Uint8Array): DiffFileStat[] {
  const text = Buffer.from(patch).toString('utf8')
  const files: DiffFileStat[] = []
  let current: DiffFileStat | null = null
  let inHunk = false
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const path = pathOfHeader(line.slice(11))
      current =
        path === null
          ? { path: line.slice(11), additions: 0, deletions: 0, unreadable: true }
          : { path, additions: 0, deletions: 0 }
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
