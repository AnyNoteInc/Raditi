import { bucketKinds, forbidden, type BucketKind, type ObjectStorage } from '@repo/domain'
import { createS3ObjectStorage, type StorageConfig } from '@repo/storage'

import type { BrowserInboxStorageConfig } from '../config/config.ts'
import type { ArtifactFilesReader } from './render-service.ts'

/**
 * The files of artifacts the renderer reads (docs/plan/88-artifacts.md, §7.12): the artifacts
 * bucket, every kind naming it, read only and only under `artifacts/` — never a write, never
 * another bucket, even past a bug of the caller.
 */
export function artifactFilesOnly(storage: Pick<ObjectStorage, 'get'>): ArtifactFilesReader {
  return {
    async get(bucket, key) {
      if (bucket !== 'artifacts' || !key.startsWith('artifacts/') || key.includes('..'))
        throw forbidden('The renderer reads the files of artifacts only')
      return storage.get(bucket, key)
    },
  }
}

export function createArtifactFiles(config: BrowserInboxStorageConfig): ArtifactFilesReader {
  const storage: StorageConfig = {
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
    buckets: Object.fromEntries(
      bucketKinds.map((kind) => [kind, config.buckets.artifacts]),
    ) as Record<BucketKind, string>,
  }
  return artifactFilesOnly(createS3ObjectStorage(storage))
}
