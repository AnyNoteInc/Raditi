import { type CellValue, type ColumnId, LIMITS, type PriceRow } from './model'

/** Operations in the format of plan 88 §7.2, as the cabinet would send them with `artifact.apply`. */
export type Op =
  | { op: 'cells'; block: string; cells: Partial<Record<ColumnId, CellValue>> }
  | { op: 'insert'; block: string; after: string | null; kind: 'row'; props: { cells: Omit<PriceRow, 'id'> } }
  | { op: 'delete'; block: string; ifRev: number }

export interface Batch {
  artifactId: string
  opId: string
  ops: Op[]
}

export interface SentBatch {
  opId: string
  ops: number
  bytes: number
  kinds: Record<string, number>
}

export type CellChange = { id: string; cells: Partial<Record<ColumnId, CellValue>> }
export type Insert = { after: string | null; row: PriceRow }

type Listener = () => void
type Undo = { label: string; before: CellChange[]; inserted: string[] }

const encoder = new TextEncoder()

/**
 * The rows of one table on the client: the latest values, a listener per row and one for the
 * shape (rows added or removed). A cell edit notifies only its row, so a row elsewhere does not
 * render again, and the order on screen does not move under the cursor.
 */
export class RowStore {
  readonly rows = new Map<string, PriceRow>()
  readonly revs = new Map<string, number>()
  /** Document order (the `rank` of blocks). */
  order: string[] = []
  shapeVersion = 0
  readonly sent: SentBatch[] = []
  readonly undoStack: Undo[] = []
  private readonly rowListeners = new Map<string, Set<Listener>>()
  private readonly shapeListeners = new Set<Listener>()
  private readonly cellListeners = new Set<(changes: CellChange[], origin: 'local' | 'remote') => void>()
  /** Where a new row goes in a sorted or filtered view: after this row, or at the end (`null`). */
  readonly placement = new Map<string, string | null>()
  private opSeq = 0
  private nextRow = 1
  send: (batch: Batch) => void = () => {}

  constructor(
    rows: PriceRow[],
    readonly artifactId = 'a-price-list',
  ) {
    for (const row of rows) {
      this.rows.set(row.id, row)
      this.revs.set(row.id, 1)
      this.order.push(row.id)
    }
    this.nextRow = rows.length + 1
  }

  get(id: string): PriceRow | undefined {
    return this.rows.get(id)
  }

  subscribeRow = (id: string, listener: Listener): (() => void) => {
    let set = this.rowListeners.get(id)
    if (!set) {
      set = new Set()
      this.rowListeners.set(id, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.rowListeners.delete(id)
    }
  }

  subscribeShape = (listener: Listener): (() => void) => {
    this.shapeListeners.add(listener)
    return () => this.shapeListeners.delete(listener)
  }

  onCells(listener: (changes: CellChange[], origin: 'local' | 'remote') => void): () => void {
    this.cellListeners.add(listener)
    return () => this.cellListeners.delete(listener)
  }

  newRowId(): string {
    // A client-side block id, as `insert` may carry its own id (Ар14).
    let id: string
    do {
      id = `n${(this.nextRow++).toString(36).padStart(4, '0')}`
    } while (this.rows.has(id))
    return id
  }

  /** Applies a person's edit: the store first, then the operations. Returns what was sent. */
  applyLocal(label: string, changes: CellChange[], inserts: Insert[] = []): SentBatch[] {
    const before: CellChange[] = []
    const ops: Op[] = []
    for (const change of changes) {
      const row = this.rows.get(change.id)
      if (!row) continue
      const old: Partial<Record<ColumnId, CellValue>> = {}
      const next: Partial<Record<ColumnId, CellValue>> = {}
      for (const [key, value] of Object.entries(change.cells) as [ColumnId, CellValue][]) {
        if (row[key] === value) continue
        old[key] = row[key]
        next[key] = value
      }
      if (Object.keys(next).length === 0) continue
      before.push({ id: change.id, cells: old })
      ops.push({ op: 'cells', block: change.id, cells: next })
    }
    for (const insert of inserts) {
      const { id, ...cells } = insert.row
      ops.push({ op: 'insert', block: id, after: insert.after, kind: 'row', props: { cells } })
    }
    if (ops.length === 0) return []
    this.writeCells(
      ops.flatMap((op) => (op.op === 'cells' ? [{ id: op.block, cells: op.cells }] : [])),
      'local',
    )
    if (inserts.length > 0) this.writeInserts(inserts)
    this.undoStack.push({ label, before, inserted: inserts.map((i) => i.row.id) })
    if (this.undoStack.length > 100) this.undoStack.shift()
    return this.flush(ops)
  }

  /** The person's last own change, undone by new operations (the server sees an ordinary edit). */
  undo(): { label: string; batches: SentBatch[] } | null {
    const last = this.undoStack.pop()
    if (!last) return null
    const ops: Op[] = last.before
      .filter((c) => this.rows.has(c.id))
      .map((c) => ({ op: 'cells', block: c.id, cells: c.cells }) as Op)
    for (const id of last.inserted) {
      if (this.rows.has(id)) ops.push({ op: 'delete', block: id, ifRev: this.revs.get(id) ?? 1 })
    }
    this.writeCells(
      ops.flatMap((op) => (op.op === 'cells' ? [{ id: op.block, cells: op.cells }] : [])),
      'local',
    )
    this.writeDeletes(last.inserted)
    return { label: last.label, batches: this.flush(ops) }
  }

  /** Changes made by someone else (another person, an agent, a scheduled task). */
  applyRemote(changes: CellChange[]): void {
    this.writeCells(changes, 'remote')
  }

  private writeCells(changes: CellChange[], origin: 'local' | 'remote'): void {
    const touched: string[] = []
    for (const change of changes) {
      const row = this.rows.get(change.id)
      if (!row) continue
      this.rows.set(change.id, { ...row, ...change.cells } as PriceRow)
      this.revs.set(change.id, (this.revs.get(change.id) ?? 0) + 1)
      touched.push(change.id)
    }
    for (const id of touched) this.rowListeners.get(id)?.forEach((l) => l())
    if (touched.length > 0) this.cellListeners.forEach((l) => l(changes, origin))
  }

  private writeInserts(inserts: Insert[]): void {
    for (const insert of inserts) {
      this.rows.set(insert.row.id, insert.row)
      this.revs.set(insert.row.id, 1)
      const at = insert.after === null ? -1 : this.order.indexOf(insert.after)
      this.order.splice(at + 1, 0, insert.row.id)
    }
    this.shapeVersion++
    this.shapeListeners.forEach((l) => l())
  }

  private writeDeletes(ids: string[]): void {
    if (ids.length === 0) return
    const gone = new Set(ids)
    for (const id of ids) {
      this.rows.delete(id)
      this.revs.delete(id)
    }
    this.order = this.order.filter((id) => !gone.has(id))
    this.shapeVersion++
    this.shapeListeners.forEach((l) => l())
  }

  /** Splits operations into batches of at most 50 operations and 90 KiB of JSON (plan 88 §7.2). */
  private flush(ops: Op[]): SentBatch[] {
    const out: SentBatch[] = []
    let current: Op[] = []
    let bytes = 0
    const emit = () => {
      if (current.length === 0) return
      const opId = `op-${++this.opSeq}`
      const batch: Batch = { artifactId: this.artifactId, opId, ops: current }
      const size = encoder.encode(JSON.stringify(batch)).length
      const kinds: Record<string, number> = {}
      for (const op of current) kinds[op.op] = (kinds[op.op] ?? 0) + 1
      const sent = { opId, ops: current.length, bytes: size, kinds }
      this.sent.push(sent)
      out.push(sent)
      this.send(batch)
      current = []
      bytes = 0
    }
    for (const op of ops) {
      const size = encoder.encode(JSON.stringify(op)).length + 1
      if (current.length >= LIMITS.opsPerBatch || bytes + size > LIMITS.batchBytes - 200) emit()
      current.push(op)
      bytes += size
    }
    emit()
    return out
  }
}
