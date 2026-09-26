/**
 * Object storage port — spec §14. Buckets are addressed by kind; the adapter maps kinds to
 * the raditi-* bucket names from configuration. Sandboxes never get S3 keys or presigned
 * URLs: the host moves files in and out.
 */
export const bucketKinds = [
  'inbox',
  'sessions',
  'logs',
  'artifacts',
  'backups',
  'platform',
] as const
export type BucketKind = (typeof bucketKinds)[number]

export interface PutOptions {
  contentType?: string
  sizeBytes?: number
}

export interface ObjectStorage {
  /** Atomic create for small markers (at most 64 KiB); false means the key already exists. */
  putIfAbsent(
    bucket: BucketKind,
    key: string,
    body: Uint8Array,
    opts?: PutOptions,
  ): Promise<boolean>
  put(
    bucket: BucketKind,
    key: string,
    body: Uint8Array | AsyncIterable<Uint8Array>,
    opts?: PutOptions,
  ): Promise<void>
  /** null when the object does not exist. */
  get(bucket: BucketKind, key: string): Promise<AsyncIterable<Uint8Array> | null>
  exists(bucket: BucketKind, key: string): Promise<boolean>
  delete(bucket: BucketKind, key: string): Promise<void>
  /**
   * Health: which of the given buckets are reachable (all kinds by default). Each service
   * checks only the buckets its own S3 key may access (spec §14).
   */
  checkBuckets(kinds?: readonly BucketKind[]): Promise<Partial<Record<BucketKind, boolean>>>
  // TODO(P2, M2): scoped presigned GET/PUT for runners and browsers, never sandboxes.
}
