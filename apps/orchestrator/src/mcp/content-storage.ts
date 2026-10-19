import { bucketKinds, forbidden, type BucketKind, type ObjectStorage } from '@repo/domain'
import { HEALTH_CHECK_TIMEOUT_MS } from '@repo/observability'
import { createS3ObjectStorage, type StorageConfig } from '@repo/storage'

import type { McpStorageConfig } from '../config/config.ts'

export const MCP_CONTENT_STORAGE = Symbol('MCP_CONTENT_STORAGE')

/**
 * All the mcp role does with S3: create-only snapshots, their reads, their removal, health, and
 * the screenshots of the agent's browser (plan 53, N22). A screenshot is larger than a
 * conditional write takes (64 KiB), so it is a plain `put` — which `artifactsOnly` lets reach
 * the key of a screenshot alone: no bug can overwrite a snapshot or a value of a plan with it.
 */
export type ContentStorage = Pick<
  ObjectStorage,
  'putIfAbsent' | 'put' | 'get' | 'delete' | 'checkBuckets'
>

/**
 * The S3 adapter addresses buckets by kind. The role has one bucket, so every kind names it:
 * even a call that got past `artifactsOnly` could not reach a bucket of another role.
 */
export function contentStorageConfig(config: McpStorageConfig): StorageConfig {
  return {
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
    buckets: Object.fromEntries(
      bucketKinds.map((kind) => [kind, config.buckets.artifacts]),
    ) as Record<BucketKind, string>,
  }
}

/** The one shape of key `put` may write: `tasks/<taskId>/screenshots/<id>.png` (N22). */
const SCREENSHOT_KEY =
  /^tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/screenshots\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/

/** The S3 key of the mcp role reaches the artifacts bucket alone (spec §14); so does this. */
export function artifactsOnly(storage: ObjectStorage): ContentStorage {
  const only = (bucket: BucketKind) => {
    if (bucket !== 'artifacts') throw forbidden('The mcp role uses the artifacts bucket only')
  }
  return {
    async putIfAbsent(bucket, key, body, opts) {
      only(bucket)
      return storage.putIfAbsent(bucket, key, body, opts)
    },
    async put(bucket, key, body, opts) {
      only(bucket)
      if (!SCREENSHOT_KEY.test(key))
        throw forbidden('The mcp role overwrites no object but a screenshot of its own key')
      return storage.put(bucket, key, body, opts)
    },
    async get(bucket, key) {
      only(bucket)
      return storage.get(bucket, key)
    },
    async delete(bucket, key) {
      only(bucket)
      return storage.delete(bucket, key)
    },
    async checkBuckets() {
      const checked = await storage.checkBuckets(['artifacts'])
      return { artifacts: checked.artifacts === true }
    },
  }
}

export function createContentStorage(config: McpStorageConfig): ContentStorage {
  return artifactsOnly(
    createS3ObjectStorage(contentStorageConfig(config), undefined, {
      healthTimeoutMs: HEALTH_CHECK_TIMEOUT_MS,
    }),
  )
}
