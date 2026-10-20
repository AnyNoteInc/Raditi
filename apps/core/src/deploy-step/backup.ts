import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress, zstdCompressSync } from 'node:zlib'

import {
  badRequest,
  dbObjectStateSchema,
  dbStateHashMaterial,
  deployBackupAad,
  isOptionState,
  isRecordState,
  releaseApiLimits,
  type DbOptionState,
  type PublishedContentState,
} from '@repo/domain'
import { extract, pack } from 'tar-stream'
import { z } from 'zod'

import { openDeployEnvelope, sealDeployEnvelope } from './envelope.ts'

// The backup of one deploy attempt (Р30): exactly the files the attempt overwrites or deletes, the
// prior states of the records and settings it changes, and the folders it makes (absent before
// it). A new record and a table have no prior state to keep: the rollback trashes the one and
// keeps the other (docs/plan/53, «Операции БД и миграции»). A tar
// archive compressed with zstd, then sealed with the attempt's data key (envelope.ts,
// `deployBackupAad`). Inside:
//
//   backup.json        what the archive holds: each file's path, SHA-256, size and mode, each
//                      record's object and state hash, the folders the release makes (outermost
//                      first: its rollback removes them, deepest first, where they are empty)
//   files/<n>          the bytes of file n of backup.json
//   records/<n>.json   the state of record or setting n as the site's plugin answered it
//
// Paths of the site never become names in the archive: nothing in it can point anywhere.

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export interface BackupFile {
  path: string
  bytes: Uint8Array
  /** Permission bits as the hosting reported them; null — it does not tell (FTP). */
  mode: number | null
}

export interface BackupContents {
  releaseId: string
  deployAttempt: number
  files: BackupFile[]
  /** Records and settings: what the rollback writes back. */
  records: (PublishedContentState | DbOptionState)[]
  /** Folders of the site absent before the release that its additions need: outermost first. */
  folders: string[]
}

const indexSchema = z.strictObject({
  v: z.literal(1),
  releaseId: z.uuid(),
  deployAttempt: z.number().int().min(1),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1024),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        size: z.number().int().min(0),
        mode: z.number().int().min(0).max(0o7777).nullable(),
      }),
    )
    .max(releaseApiLimits.files),
  records: z
    .array(z.strictObject({ objectRef: z.string().min(1).max(128), stateHash: z.string() }))
    .max(releaseApiLimits.files),
  folders: z.array(z.string().min(1).max(1024)).max(releaseApiLimits.files),
})

const invalid = () => badRequest('Invalid deploy backup')

/** The plaintext archive: deterministic for the same contents (no times, no owners). */
export async function packBackup(contents: BackupContents): Promise<Buffer> {
  const index = {
    v: 1,
    releaseId: contents.releaseId,
    deployAttempt: contents.deployAttempt,
    files: contents.files.map((file) => ({
      path: file.path,
      sha256: sha256(file.bytes),
      size: file.bytes.byteLength,
      mode: file.mode,
    })),
    records: contents.records.map((record) => ({
      objectRef: record.objectRef,
      stateHash: record.stateHash,
    })),
    folders: contents.folders,
  }
  const total =
    contents.files.reduce((sum, file) => sum + file.bytes.byteLength, 0) +
    contents.records.reduce((sum, record) => sum + JSON.stringify(record).length * 4, 0)
  if (total > releaseApiLimits.backupBytes) throw invalid()
  const stream = pack()
  const entry = (name: string, body: Uint8Array) =>
    stream.entry({ name, mode: 0o600, mtime: new Date(0), uid: 0, gid: 0 }, Buffer.from(body))
  entry('backup.json', Buffer.from(JSON.stringify(index), 'utf8'))
  contents.files.forEach((file, number) => entry(`files/${number}`, file.bytes))
  contents.records.forEach((record, number) =>
    entry(`records/${number}.json`, Buffer.from(JSON.stringify(record), 'utf8')),
  )
  stream.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return zstdCompressSync(Buffer.concat(chunks))
}

/** Reads back what packBackup wrote: every entry named, every file of its size and hash. */
export async function unpackBackup(archive: Uint8Array): Promise<BackupContents> {
  const entries = new Map<string, Buffer>()
  let total = 0
  const parser = extract()
  parser.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = []
    stream.on('error', () => {})
    stream.on('data', (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array)) {
        parser.destroy(invalid())
        return
      }
      total += chunk.byteLength
      if (total > releaseApiLimits.backupBytes) parser.destroy(invalid())
      else chunks.push(Buffer.from(chunk))
    })
    stream.on('end', () => {
      if (header.type !== 'file' || entries.has(header.name)) {
        parser.destroy(invalid())
        return
      }
      entries.set(header.name, Buffer.concat(chunks))
      next()
    })
    stream.resume()
  })
  try {
    await pipeline(Readable.from([Buffer.from(archive)]), createZstdDecompress(), parser)
  } catch {
    throw invalid()
  }
  const rawIndex = entries.get('backup.json')
  if (!rawIndex) throw invalid()
  let index: z.infer<typeof indexSchema>
  try {
    index = indexSchema.parse(JSON.parse(rawIndex.toString('utf8')))
  } catch {
    throw invalid()
  }
  const expected = new Set([
    'backup.json',
    ...index.files.map((_, number) => `files/${number}`),
    ...index.records.map((_, number) => `records/${number}.json`),
  ])
  if (entries.size !== expected.size || [...entries.keys()].some((name) => !expected.has(name)))
    throw invalid()
  const files = index.files.map((file, number) => {
    const bytes = entries.get(`files/${number}`)!
    if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) throw invalid()
    return { path: file.path, bytes, mode: file.mode }
  })
  const records = index.records.map((record, number) => {
    let state
    try {
      state = dbObjectStateSchema.parse(
        JSON.parse(entries.get(`records/${number}.json`)!.toString('utf8')),
      )
    } catch {
      throw invalid()
    }
    // The hash of its own fields too: a rollback writes these bytes back in `restore`.
    if (
      (!isRecordState(state) && !isOptionState(state)) ||
      state.objectRef !== record.objectRef ||
      state.stateHash !== record.stateHash ||
      sha256(Buffer.from(dbStateHashMaterial(state), 'utf8')) !== state.stateHash
    )
      throw invalid()
    return state
  })
  return {
    releaseId: index.releaseId,
    deployAttempt: index.deployAttempt,
    files,
    records,
    folders: index.folders,
  }
}

/** The sealed backup: what the job uploads and core checks by size and SHA-256. */
export async function sealBackup(contents: BackupContents, key: Uint8Array) {
  const sealed = sealDeployEnvelope(
    await packBackup(contents),
    key,
    deployBackupAad(contents.releaseId, contents.deployAttempt),
  )
  return { sealed, sha256: sha256(sealed), sizeBytes: sealed.byteLength }
}

/** Opens a sealed backup of one attempt; another attempt's or a changed one does not open. */
export async function openBackup(
  sealed: Uint8Array,
  key: Uint8Array,
  releaseId: string,
  deployAttempt: number,
): Promise<BackupContents> {
  const contents = await unpackBackup(
    openDeployEnvelope(sealed, key, deployBackupAad(releaseId, deployAttempt)),
  )
  if (contents.releaseId !== releaseId || contents.deployAttempt !== deployAttempt) throw invalid()
  return contents
}
