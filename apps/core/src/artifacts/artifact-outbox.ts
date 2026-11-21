import { createHash } from 'node:crypto'

import {
  applyArtifactOps,
  artifactFilesOfTurn,
  artifactImportsOfTurn,
  createArtifact,
  dropArtifactFile,
  markArtifactFileReady,
  readArtifact,
  settleArtifactImport,
  type ArtifactFileRow,
  type ArtifactImportRow,
  type PrismaClient,
} from '@repo/db'
import { artifactImportOf, type ImportedBlock } from '@repo/doc-bridge'
import { checkPageContent, isDomainError, type ObjectStorage } from '@repo/domain'
import {
  artifactImportKindOf,
  artifactKindCreatable,
  artifactLimits,
  checkArtifactFile,
  type ArtifactOp,
} from '@repo/domain/artifacts'
import { readOutboxArchive } from '@repo/snapshots'

// What a turn put from its outbox into artifacts (docs/plan/88-artifacts.md, §7.5; slice 88.12):
// the files `artifact_file_put` reserved — a picture or a font, checked by its type and first
// bytes (an SVG as a page is) and put into the artifacts bucket — and the imports of
// `artifact_import` — a `.md`, `.html`, `.svg` or `.csv` become the blocks of a new artifact, or
// the new content of one the chat may write. The blocks are the agent's writes: they wait for the
// check of the end of the turn as any other (§7.3), so this runs before it. The outbox was already
// scanned for the keys of the turn and the values of the client (`readOutboxArchive({ refused })`).
// A file the artifacts took is no file of the chat. Never throws: what did not come true is a line
// of the log and a reservation closed.

export interface ArtifactOutboxDependencies {
  db: PrismaClient
  storage: Pick<ObjectStorage, 'put'>
  logger?: { log(message: string): void; warn(message: string): void }
}

const decoder = new TextDecoder('utf-8', { fatal: true })

/** The operations of a batch fit the bounds of a batch of the agent: 50 operations, ~88 KiB. */
function batchesOf(ops: ArtifactOp[]): ArtifactOp[][] {
  const out: ArtifactOp[][] = []
  let batch: ArtifactOp[] = []
  let size = 0
  for (const op of ops) {
    const bytes = JSON.stringify(op).length * 2
    if (
      batch.length > 0 &&
      (batch.length >= artifactLimits.batchOps ||
        size + bytes > artifactLimits.batchJsonBytes - 4096)
    ) {
      out.push(batch)
      batch = []
      size = 0
    }
    batch.push(op)
    size += bytes
  }
  if (batch.length > 0) out.push(batch)
  return out
}

/** Insertions of imported blocks, in order after `after`. */
function insertsOf(
  blocks: readonly ImportedBlock[],
  after: string | null,
  prefix: string,
): ArtifactOp[] {
  let last = after
  return blocks.map((block, at) => {
    const key = `${prefix}${at + 1}`
    const op: ArtifactOp = {
      op: 'insert',
      block: key,
      after: last,
      kind: block.kind,
      content: block.content,
      ...(block.heading === undefined ? {} : { props: { heading: block.heading } }),
    }
    last = key
    return op
  })
}

export class ArtifactOutbox {
  readonly #deps: ArtifactOutboxDependencies

  constructor(deps: ArtifactOutboxDependencies) {
    this.#deps = deps
  }

  /**
   * Takes what the artifacts reserved of this outbox; returns the names it took, which the files of
   * the chat leave out. `outbox` null — the turn left nothing: the reservations are closed.
   */
  async take(input: {
    taskId: string
    turn: number
    outbox: Uint8Array | null
  }): Promise<Set<string>> {
    const { db, logger } = this.#deps
    const taken = new Set<string>()
    let files = new Map<string, ArtifactFileRow>()
    let imports = new Map<string, ArtifactImportRow>()
    try {
      files = await artifactFilesOfTurn(db, { taskId: input.taskId, turnNo: input.turn })
      imports = await artifactImportsOfTurn(db, { taskId: input.taskId, turnNo: input.turn })
      if (files.size === 0 && imports.size === 0) return taken
      for (const name of [...files.keys(), ...imports.keys()]) taken.add(name)
      if (input.outbox === null) return taken
      const found: { name: string; bytes: Uint8Array }[] = []
      const contents = await readOutboxArchive(input.outbox, {
        onFile: async (file) => {
          if (files.has(file.name) || imports.has(file.name))
            found.push({ name: file.name, bytes: new Uint8Array(file.bytes) })
        },
      })
      if (!contents.refused)
        for (const file of found) {
          const reserved = files.get(file.name)
          if (reserved) await this.#file(reserved, file.bytes, input)
          const reservedImport = imports.get(file.name)
          if (reservedImport) await this.#import(reservedImport, file.name, file.bytes, input)
        }
    } catch (error) {
      logger?.warn(
        `artifact_outbox_failed task=${input.taskId} turn=${input.turn} reason=${isDomainError(error) ? error.code : 'unknown'}`,
      )
    } finally {
      // What never came, or did not pass, goes.
      for (const row of files.values()) await dropArtifactFile(db, row.id).catch(() => undefined)
      for (const row of imports.values())
        await settleArtifactImport(db, { id: row.id, state: 'refused' }).catch(() => undefined)
    }
    return taken
  }

  async #file(row: ArtifactFileRow, bytes: Uint8Array, at: { taskId: string; turn: number }) {
    const { db, storage, logger } = this.#deps
    if (row.state === 'ready') return
    const verdict = checkArtifactFile(row.name, bytes)
    const text =
      verdict.ok && verdict.type === 'image/svg+xml' ? checkPageContent(bytes) : { ok: true }
    if (!verdict.ok || !text.ok) {
      logger?.warn(
        `artifact_file_refused task=${at.taskId} turn=${at.turn} reason=${verdict.ok ? 'content' : verdict.reason}`,
      )
      return
    }
    await storage.put('artifacts', row.objectKey, bytes, {
      contentType: verdict.type,
      sizeBytes: bytes.byteLength,
    })
    await markArtifactFileReady(db, {
      id: row.id,
      contentType: verdict.type,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    logger?.log(`artifact_file_written task=${at.taskId} turn=${at.turn}`)
  }

  async #import(
    row: ArtifactImportRow,
    name: string,
    bytes: Uint8Array,
    at: { taskId: string; turn: number },
  ) {
    const { db, logger } = this.#deps
    if (row.state !== 'reserved') return
    const refuse = async (reason: string) => {
      logger?.warn(`artifact_import_refused task=${at.taskId} turn=${at.turn} reason=${reason}`)
      await settleArtifactImport(db, { id: row.id, state: 'refused' })
    }
    const kind = artifactImportKindOf(name)
    if (kind === null || !artifactKindCreatable(kind)) return refuse('kind')
    if (bytes.byteLength > artifactLimits.importBytes) return refuse('too_large')
    let text: string
    try {
      text = decoder.decode(bytes)
    } catch {
      return refuse('not_utf8')
    }
    const imported = artifactImportOf(name, text, {
      blockBytes: artifactLimits.blockBytes,
      blocks: artifactLimits.blocks,
      tableRows: artifactLimits.tableRows,
      columns: 50,
    })
    if (!imported.ok) return refuse(imported.problem)
    const actor = {
      kind: 'agent' as const,
      taskId: at.taskId,
      turnNo: at.turn,
      outbox: true as const,
    }
    // The new blocks go in first and the old ones go after them: a refusal half-way leaves the
    // artifact as it was — the new artifact is removed, the blocks already in are taken out.
    const prefix = `i${row.id.slice(-6)}-`
    const inserts = insertsOf(imported.blocks, null, prefix)
    let created = false
    try {
      let removals: ArtifactOp[] = []
      if (row.intoExisting) {
        const current = await readArtifact(db, { artifactId: row.artifactId, actor })
        if (current.kind !== imported.kind) return refuse('kind')
        removals = current.blocks
          .filter((block) => block.parent === null)
          .map((block) => ({ op: 'delete', block: block.key, ifRev: block.rev }))
      } else {
        const task = await db.task.findUniqueOrThrow({
          where: { id: at.taskId },
          select: { workspaceId: true, projectId: true },
        })
        await createArtifact(db, {
          id: row.artifactId,
          workspaceId: task.workspaceId,
          kind: imported.kind,
          title: row.title ?? imported.title ?? name.replace(/\.[^.]+$/, '').slice(0, 200),
          projectId: row.personal ? null : task.projectId,
          actor,
        })
        created = true
      }
      try {
        await this.#apply(row.artifactId, `import-${row.id}`, inserts, actor)
      } catch (error) {
        await this.#undo(row.artifactId, prefix, created, actor)
        throw error
      }
      if (removals.length > 0)
        await this.#apply(row.artifactId, `import-${row.id}-del`, removals, actor)
      await settleArtifactImport(db, { id: row.id, state: 'done' })
      logger?.log(`artifact_imported task=${at.taskId} turn=${at.turn} blocks=${inserts.length}`)
    } catch (error) {
      await refuse(isDomainError(error) ? error.code : 'unknown')
    }
  }

  /** What a refused import put in goes again: the artifact it created, or its blocks. */
  async #undo(
    artifactId: string,
    prefix: string,
    created: boolean,
    actor: { kind: 'agent'; taskId: string; turnNo: number; outbox: true },
  ) {
    const { db } = this.#deps
    try {
      if (created) {
        await db.artifact.deleteMany({ where: { id: artifactId, taskId: actor.taskId } })
        return
      }
      const current = await readArtifact(db, { artifactId, actor })
      const back: ArtifactOp[] = current.blocks
        .filter((block) => block.key.startsWith(prefix))
        .map((block) => ({ op: 'delete', block: block.key, ifRev: block.rev }))
      if (back.length > 0) await this.#apply(artifactId, `import-undo-${prefix}`, back, actor)
    } catch {
      this.#deps.logger?.warn('artifact_import_undo_failed')
    }
  }

  async #apply(
    artifactId: string,
    opId: string,
    ops: ArtifactOp[],
    actor: { kind: 'agent'; taskId: string; turnNo: number; outbox: true },
  ) {
    let at = 0
    for (const batch of batchesOf(ops))
      await applyArtifactOps(this.#deps.db, {
        batch: { artifactId, opId: `${opId}-${at++}`, ops: batch },
        actor,
      })
  }
}
