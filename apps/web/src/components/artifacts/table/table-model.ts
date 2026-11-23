import {
  artifactLimits,
  jsonNodeCount,
  type ArtifactCells,
  type ArtifactColumn,
  type ArtifactOp,
} from '@repo/domain/artifacts'

// What the table of the cabinet keeps of its own (docs/plan/88-artifacts.md, §7.2, §7.7): the
// keys of new rows, the batches of a large paste, which columns are shown, pinned and in what
// order (a convenience of this browser), and the undo of the person's own edits.

/** A key of a new row the cabinet gives (the rule of `section_key`): the paste can name it. */
export function newRowKey(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return `r-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** The cabinet keeps a batch below the bounds of §7.2, with room for its envelope. */
const CHUNK_BYTES = artifactLimits.batchJsonBytes - 4 * 1024
const CHUNK_NODES = artifactLimits.batchJsonNodes - 100
/** Operations counted against the 50 of a batch: all but the rows of the cabinet. */
const counted = (op: ArtifactOp) =>
  !(op.op === 'cells' || (op.op === 'insert' && op.kind === 'row'))

/**
 * Operations split into batches the server takes: up to ~86 KiB and ~3 900 values of JSON each,
 * and 50 operations that count. A paste of 300 rows of 6 columns is one batch (spike 5); a longer
 * one goes in several, in order.
 */
export function batchesOf(ops: readonly ArtifactOp[]): ArtifactOp[][] {
  const batches: ArtifactOp[][] = []
  let current: ArtifactOp[] = []
  let bytes = 0
  let nodes = 0
  let ops50 = 0
  const encoder = new TextEncoder()
  for (const op of ops) {
    const size = encoder.encode(JSON.stringify(op)).byteLength + 1
    const values = jsonNodeCount(op)
    const one = counted(op) ? 1 : 0
    if (
      current.length > 0 &&
      (bytes + size > CHUNK_BYTES ||
        nodes + values > CHUNK_NODES ||
        ops50 + one > artifactLimits.batchOps)
    ) {
      batches.push(current)
      current = []
      bytes = 0
      nodes = 0
      ops50 = 0
    }
    current.push(op)
    bytes += size
    nodes += values
    ops50 += one
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** The cells a write is about to change, as they were: what undo writes back (null — absent). */
export function cellsBefore(cells: ArtifactCells, change: ArtifactCells): ArtifactCells {
  const before: ArtifactCells = {}
  for (const key of Object.keys(change)) before[key] = cells[key] ?? null
  return before
}

/** What the person did, and how to take it back (Ctrl+Z, §7.7). */
export type TableUndo =
  | { type: 'cells'; changes: { key: string; before: ArtifactCells }[] }
  | { type: 'insert'; keys: string[] }
  | { type: 'delete'; rows: { key: string; cells: ArtifactCells; after: string | null }[] }
  | { type: 'columns'; before: ArtifactColumn[] }

/** The columns this browser shows, in its order, and the pinned ones: a convenience, not shared. */
export interface ColumnLayout {
  order: string[]
  hidden: string[]
  pinned: string[]
}

/** The layout of these columns: the stored one where it still fits, the first column pinned. */
export function layoutOf(
  columns: readonly ArtifactColumn[],
  stored: Partial<ColumnLayout> | null,
): ColumnLayout {
  const keys = columns.map((column) => column.key)
  const known = new Set(keys)
  const order = [...(stored?.order ?? []).filter((key) => known.has(key))]
  for (const key of keys) if (!order.includes(key)) order.push(key)
  const hidden = (stored?.hidden ?? []).filter((key) => known.has(key))
  const pinned =
    stored?.pinned !== undefined ? stored.pinned.filter((key) => known.has(key)) : keys.slice(0, 1)
  return { order, hidden, pinned }
}

/** The columns in the order of the layout, shown ones only; the pinned first. */
export function shownColumns(
  columns: readonly ArtifactColumn[],
  layout: ColumnLayout,
): ArtifactColumn[] {
  const byKey = new Map(columns.map((column) => [column.key, column]))
  const shown = layout.order
    .filter((key) => !layout.hidden.includes(key))
    .flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : []))
  return [
    ...shown.filter((column) => layout.pinned.includes(column.key)),
    ...shown.filter((column) => !layout.pinned.includes(column.key)),
  ]
}

const LAYOUT_KEY = (artifactId: string) => `raditi:table-layout:${artifactId}`

/** The stored layout of this browser; nothing when storage is away (private window, previews). */
export function readLayout(artifactId: string): Partial<ColumnLayout> | null {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY(artifactId))
    return raw === null ? null : (JSON.parse(raw) as Partial<ColumnLayout>)
  } catch {
    return null
  }
}

export function storeLayout(artifactId: string, layout: ColumnLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY(artifactId), JSON.stringify(layout))
  } catch {
    // A convenience: without storage the layout lives as long as the page.
  }
}

/** The card of a row on a phone: its name, its sum, its choice and unit, and its flag. */
export function cardColumnsOf(columns: readonly ArtifactColumn[]) {
  const texts = columns.filter((column) => column.type === 'text')
  return {
    name: texts[0] ?? null,
    money: columns.find((column) => column.type === 'money') ?? null,
    choice: columns.find((column) => column.type === 'select') ?? null,
    unit: texts[1] ?? null,
    flag: columns.find((column) => column.type === 'checkbox') ?? null,
  }
}
