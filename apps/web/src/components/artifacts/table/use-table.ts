'use client'

import {
  artifactRoleAtLeast,
  tableOfBlocks,
  type ArtifactCells,
  type ArtifactColumn,
  type ArtifactOp,
  type TableRow,
} from '@repo/domain/artifacts'
import { useMutation } from '@tanstack/react-query'
import { useCallback, useMemo, useRef, useState } from 'react'

import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC } from '@/trpc/client'

import type { CabinetArtifact } from '../use-artifact'
import { batchesOf, cellsBefore, newRowKey, type TableUndo } from './table-model'

// The table of an artifact and what the person writes in it (docs/plan/88-artifacts.md, §7.2,
// §7.7): the rows of its checked blocks with the person's own writes on top until the next read,
// batches of operations — a row an agent holds (`ARTIFACT_BLOCK_HELD`) is left out and the rest
// goes again, the skipped rows named —, and the undo of the person's own edits.

interface WriteError {
  data?: { domainCode?: string | null; artifact?: { block?: string } }
}

export interface TableWrite {
  /** Rows the write left as they were: an agent holds them. */
  skipped: string[]
}

const UNDO_DEPTH = 50

export function useTable(artifact: CabinetArtifact, onChanged: () => void) {
  const trpc = useTRPC()
  const write = useMutation(trpc.artifact.write.mutationOptions())
  const table = useMemo(() => tableOfBlocks(artifact.blocks), [artifact.blocks])
  const held = useMemo(
    () =>
      new Set(
        artifact.blocks
          // An agent's write or claim holds a row; a person's own lease of the rows they just
          // wrote does not (another person's is refused by the server, and named as skipped).
          .filter((block) => block.kind === 'row' && (block.checking || block.hold === 'claim'))
          .map((block) => block.key),
      ),
    [artifact.blocks],
  )
  // The person's writes until the next read of the artifact shows them.
  const [overlay, setOverlay] = useState<{ seq: number; cells: Map<string, ArtifactCells> }>({
    seq: artifact.seq,
    cells: new Map(),
  })
  const own = useMemo(
    () => (overlay.seq === artifact.seq ? overlay.cells : new Map<string, ArtifactCells>()),
    [overlay, artifact.seq],
  )
  const rows: TableRow[] = useMemo(
    () =>
      own.size === 0
        ? table.rows
        : table.rows.map((row) => {
            const patch = own.get(row.key)
            if (!patch) return row
            const cells = { ...row.cells }
            for (const [key, value] of Object.entries(patch))
              if (value === null) delete cells[key]
              else cells[key] = value
            return { ...row, cells }
          }),
    [table.rows, own],
  )
  const undo = useRef<TableUndo[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const canEdit = artifactRoleAtLeast(artifact.role, 'edit')

  const send = useCallback(
    async (ops: ArtifactOp[]): Promise<TableWrite> => {
      const skipped: string[] = []
      setBusy(true)
      setFailed(false)
      try {
        for (const batch of batchesOf(ops)) {
          let rest = batch
          // Each try leaves out one more row an agent holds.
          for (let attempt = 0; attempt < 20 && rest.length > 0; attempt += 1) {
            try {
              await write.mutateAsync({
                batch: { artifactId: artifact.id, opId: uuidv7(), ops: rest },
              })
              break
            } catch (error) {
              const data = (error as WriteError).data
              const block = data?.artifact?.block
              if (data?.domainCode !== 'ARTIFACT_BLOCK_HELD' || block === undefined) throw error
              skipped.push(block)
              rest = rest.filter((op) => !('block' in op) || op.block !== block)
            }
          }
        }
        return { skipped }
      } catch (error) {
        setFailed(true)
        throw error
      } finally {
        setBusy(false)
        onChanged()
      }
    },
    [artifact.id, onChanged, write],
  )

  const remember = (entry: TableUndo) => {
    undo.current.push(entry)
    if (undo.current.length > UNDO_DEPTH) undo.current.shift()
  }

  const byKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows])

  /** Cells of rows that exist, and new rows after the last one (a paste). */
  const writeCells = useCallback(
    async (
      changes: readonly { key: string; cells: ArtifactCells }[],
      inserts: readonly ArtifactCells[] = [],
      { keepUndo = false }: { keepUndo?: boolean } = {},
    ): Promise<TableWrite> => {
      const real = changes.filter((change) => Object.keys(change.cells).length > 0)
      const before = real.map((change) => ({
        key: change.key,
        before: cellsBefore(byKey.get(change.key)?.cells ?? {}, change.cells),
      }))
      let after = rows.at(-1)?.key ?? table.columnsKey
      const keys: string[] = []
      const ops: ArtifactOp[] = [
        ...real.map((change) => ({ op: 'cells' as const, block: change.key, cells: change.cells })),
        ...inserts.map((cells) => {
          const key = newRowKey()
          keys.push(key)
          const op = {
            op: 'insert' as const,
            block: key,
            after,
            kind: 'row' as const,
            content: JSON.stringify(cells),
          }
          after = key
          return op
        }),
      ]
      if (ops.length === 0) return { skipped: [] }
      setOverlay((current) => {
        const cells = new Map(current.seq === artifact.seq ? current.cells : [])
        for (const change of real)
          cells.set(change.key, { ...cells.get(change.key), ...change.cells })
        return { seq: artifact.seq, cells }
      })
      const result = await send(ops)
      if (!keepUndo) {
        const done = before.filter((each) => !result.skipped.includes(each.key))
        if (done.length > 0) remember({ type: 'cells', changes: done })
        if (keys.length > 0) remember({ type: 'insert', keys })
      }
      return result
    },
    [artifact.seq, byKey, rows, send, table.columnsKey],
  )

  const deleteRows = useCallback(
    async (keys: readonly string[], { keepUndo = false }: { keepUndo?: boolean } = {}) => {
      const order = rows.map((row) => row.key)
      const gone = keys.flatMap((key) => {
        const row = byKey.get(key)
        if (!row) return []
        const at = order.indexOf(key)
        return [
          {
            key,
            cells: row.cells,
            after: at > 0 ? order[at - 1]! : table.columnsKey,
            rev: row.rev,
          },
        ]
      })
      const result = await send(
        gone.map((row) => ({ op: 'delete' as const, block: row.key, ifRev: row.rev })),
      )
      if (!keepUndo) {
        const done = gone.filter((row) => !result.skipped.includes(row.key))
        if (done.length > 0)
          remember({
            type: 'delete',
            rows: done.map(({ key, cells, after }) => ({ key, cells, after })),
          })
      }
      return result
    },
    [byKey, rows, send, table.columnsKey],
  )

  const writeColumns = useCallback(
    async (columns: ArtifactColumn[], { keepUndo = false }: { keepUndo?: boolean } = {}) => {
      const content = JSON.stringify(columns)
      const ops: ArtifactOp[] =
        table.columnsKey === null
          ? [{ op: 'insert', block: 'columns', after: null, kind: 'columns', content }]
          : [{ op: 'replace', block: table.columnsKey, ifRev: table.columnsRev, content }]
      const before = table.columns
      const result = await send(ops)
      if (!keepUndo && table.columnsKey !== null) remember({ type: 'columns', before })
      return result
    },
    [send, table.columns, table.columnsKey, table.columnsRev],
  )

  /** Ctrl+Z: the person's last own edit is taken back; false — nothing to take back. */
  const undoLast = useCallback(async (): Promise<boolean> => {
    const entry = undo.current.pop()
    if (!entry) return false
    switch (entry.type) {
      case 'cells':
        await writeCells(
          entry.changes.map((change) => ({ key: change.key, cells: change.before })),
          [],
          { keepUndo: true },
        )
        break
      case 'insert':
        await deleteRows(entry.keys, { keepUndo: true })
        break
      case 'delete':
        await send(
          entry.rows.map((row) => ({
            op: 'insert' as const,
            block: newRowKey(),
            after: row.after,
            kind: 'row' as const,
            content: JSON.stringify(row.cells),
          })),
        )
        break
      case 'columns':
        await writeColumns(entry.before, { keepUndo: true })
        break
    }
    return true
  }, [deleteRows, send, writeCells, writeColumns])

  return {
    columns: table.columns,
    rows,
    held,
    canEdit,
    busy,
    failed,
    writeCells,
    deleteRows,
    writeColumns,
    undoLast,
  }
}

export type TableState = ReturnType<typeof useTable>
