// The three-way merge of a section (docs/plan/88-artifacts.md, Ар17, Ар18; board D-conflict): two
// people — or a person whose lease ran out and an agent — changed one section from the same text.
// By lines: changes of different lines are both kept; the same change once; changes of the same
// lines that differ are a divergence — «Разошлись» shows both, and the person chooses. Pure.

/** A change of lines `[from, to)` of the base into `lines`. */
interface Hunk {
  from: number
  to: number
  lines: string[]
}

/** The longest common subsequence of two lists as pairs of indices, in order. */
function common<T>(a: readonly T[], b: readonly T[]): [number, number][] {
  const n = a.length
  const m = b.length
  // Each side is a section (≤ 32 KiB): the table stays small; beyond the bound nothing is shared.
  if (n * m > 4_000_000) return []
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1)
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1
    else j += 1
  }
  return pairs
}

function hunksOf(base: readonly string[], other: readonly string[]): Hunk[] {
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  for (const [bi, oj] of [
    ...common(base, other),
    [base.length, other.length] as [number, number],
  ]) {
    if (bi > i || oj > j) hunks.push({ from: i, to: bi, lines: other.slice(j, oj) })
    i = bi + 1
    j = oj + 1
  }
  return hunks
}

const sameHunk = (a: Hunk, b: Hunk) =>
  a.from === b.from && a.to === b.to && a.lines.join('\n') === b.lines.join('\n')

/** Two changes touch: they share lines, or both insert at one place. */
const touch = (a: Hunk, b: Hunk) =>
  a.from < b.to || b.from < a.to ? a.from < b.to && b.from < a.to : a.from === b.from

export type MergeResult = { clean: true; text: string } | { clean: false }

/** Both changes of `base`, or a divergence. */
export function mergeThree(base: string, mine: string, theirs: string): MergeResult {
  if (mine === theirs) return { clean: true, text: mine }
  if (mine === base) return { clean: true, text: theirs }
  if (theirs === base) return { clean: true, text: mine }
  const lines = base.split('\n')
  const ours = hunksOf(lines, mine.split('\n'))
  const others = hunksOf(lines, theirs.split('\n'))
  const all: Hunk[] = []
  for (const hunk of ours) {
    const clash = others.find((other) => touch(hunk, other))
    if (clash && !sameHunk(clash, hunk)) return { clean: false }
    all.push(hunk)
  }
  for (const hunk of others) if (!ours.some((own) => sameHunk(own, hunk))) all.push(hunk)
  all.sort((a, b) => a.from - b.from || a.to - b.to)
  const out: string[] = []
  let at = 0
  for (const hunk of all) {
    out.push(...lines.slice(at, hunk.from), ...hunk.lines)
    at = hunk.to
  }
  out.push(...lines.slice(at))
  return { clean: true, text: out.join('\n') }
}

/** A piece of the comparison of two texts by words: kept, taken away or added. */
export interface DiffPiece {
  kind: 'same' | 'removed' | 'added'
  text: string
}

/** What changed from `before` to `after`, word by word (spaces kept with their words). */
export function wordDiff(before: string, after: string): DiffPiece[] {
  const a = before.match(/\s*\S+|\s+$/g) ?? []
  const b = after.match(/\s*\S+|\s+$/g) ?? []
  const pairs = common(a, b)
  const pieces: DiffPiece[] = []
  const push = (kind: DiffPiece['kind'], text: string) => {
    if (text === '') return
    const last = pieces.at(-1)
    if (last?.kind === kind) last.text += text
    else pieces.push({ kind, text })
  }
  let i = 0
  let j = 0
  for (const [ai, bj] of [...pairs, [a.length, b.length] as [number, number]]) {
    push('removed', a.slice(i, ai).join(''))
    push('added', b.slice(j, bj).join(''))
    if (ai < a.length) push('same', a[ai]!)
    i = ai + 1
    j = bj + 1
  }
  return pieces
}
