import {
  attachmentKey,
  attachmentLimits,
  bucketKinds,
  browserTaskError,
  forbidden,
  type BrowserFile,
  type BucketKind,
  type ObjectStorage,
} from '@repo/domain'
import { HEALTH_CHECK_TIMEOUT_MS } from '@repo/observability'
import { createS3ObjectStorage, type StorageConfig } from '@repo/storage'

import type { BrowserInboxStorageConfig } from '../config/config.ts'
import type { BrowserWorkerStore } from '../store/worker-store.ts'

/**
 * All the worker does with S3: read attachments of tasks from the inbox, write the snapshots its
 * agent takes for the client there (`web_screenshot`, under `screenshots/`), and its health.
 */
export type InboxStorage = Pick<ObjectStorage, 'get' | 'put' | 'checkBuckets'>

/** Where in the inbox the worker may write: the snapshots of tasks (`browserTaskScreenshotKey`). */
const SCREENSHOT_PREFIX = 'screenshots/'

/**
 * The S3 adapter addresses buckets by kind. The worker has one bucket, so every kind names it:
 * even a call that got past `inboxOnly` could not reach a bucket of another role.
 */
export function inboxStorageConfig(config: BrowserInboxStorageConfig): StorageConfig {
  return {
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
    buckets: Object.fromEntries(bucketKinds.map((kind) => [kind, config.buckets.inbox])) as Record<
      BucketKind,
      string
    >,
  }
}

/**
 * The S3 key of the worker reaches the inbox alone (Б26, spec §14); so does this — and of the
 * inbox it writes the snapshots of tasks alone, never an attachment of a client.
 */
export function inboxOnly(
  storage: Pick<ObjectStorage, 'get' | 'put' | 'checkBuckets'>,
): InboxStorage {
  return {
    async get(bucket, key) {
      if (bucket !== 'inbox') throw forbidden('The browser worker reads the inbox bucket only')
      return storage.get(bucket, key)
    },
    async put(bucket, key, body, opts) {
      if (bucket !== 'inbox' || !key.startsWith(SCREENSHOT_PREFIX) || key.includes('..'))
        throw forbidden('The browser worker writes snapshots of tasks only')
      return storage.put(bucket, key, body, opts)
    },
    async checkBuckets() {
      const checked = await storage.checkBuckets(['inbox'])
      return { inbox: checked.inbox === true }
    },
  }
}

export function createInboxStorage(config: BrowserInboxStorageConfig): InboxStorage {
  return inboxOnly(
    createS3ObjectStorage(inboxStorageConfig(config), undefined, {
      healthTimeoutMs: HEALTH_CHECK_TIMEOUT_MS,
    }),
  )
}

/**
 * Files of a task for a page of its browser (Б26, Б27): an attachment is read only when the
 * database binds it to the task of the session, its key is the one of its workspace and its
 * stored size is the one recorded, at most the limit of a file. Any other id — of another task,
 * not sent yet, deleted — is `BROWSER_ATTACHMENT_UNKNOWN`, and nothing of it is read. No key,
 * address or name ever reaches an error.
 */
export class AttachmentFiles {
  readonly #store: Pick<BrowserWorkerStore, 'attachment'>
  readonly #inbox: InboxStorage

  constructor(store: Pick<BrowserWorkerStore, 'attachment'>, inbox: InboxStorage) {
    this.#store = store
    this.#inbox = inbox
  }

  async read(input: {
    taskId: string
    siteId: string
    attachmentIds: readonly string[]
  }): Promise<BrowserFile[]> {
    const unknown = () => browserTaskError('BROWSER_ATTACHMENT_UNKNOWN')
    if (input.attachmentIds.length > attachmentLimits.perMessage) throw unknown()
    const rows = []
    // Every id is checked before any byte is read.
    for (const id of input.attachmentIds) {
      const row = await this.#store.attachment({ id, taskId: input.taskId })
      if (
        row === null ||
        row.siteId !== input.siteId ||
        row.sizeBytes < 1 ||
        row.sizeBytes > attachmentLimits.fileBytes ||
        row.s3Key !== attachmentKey(row.workspaceId, row.id)
      )
        throw unknown()
      rows.push(row)
    }
    const files: BrowserFile[] = []
    for (const row of rows) {
      const body = await this.#inbox.get('inbox', row.s3Key)
      if (body === null) throw unknown()
      const bytes = await readAtMost(body, row.sizeBytes)
      if (bytes === null || bytes.byteLength !== row.sizeBytes) throw unknown()
      files.push({ name: row.fileName, mimeType: row.contentType, bytes })
    }
    return files
  }
}

/** The whole body when it is at most `limit` bytes; null — larger. */
async function readAtMost(
  body: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of body) {
    size += chunk.byteLength
    if (size > limit) return null
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}
