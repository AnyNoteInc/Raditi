/**
 * Object storage port — spec §14. Buckets are addressed by kind; the adapter maps kinds to
 * the raditi-* bucket names from configuration. Sandboxes never get S3 keys or presigned
 * URLs: the host moves files in and out; a runner host gets scoped presigned URLs from core.
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

/**
 * Turn snapshots are reachable by a presigned URL (P2): a runner restores turn n−1 and writes
 * home.tar.zst of turn n. So is the encrypted backup of a release (plan 53, Р30): its deploy job
 * uploads it and reads the values of its database plan, with no S3 credential of its own.
 * Browser uploads (M2) and runner logs (P12) come later.
 */
export const presignableBuckets = ['sessions', 'backups'] as const
export type PresignableBucket = (typeof presignableBuckets)[number]
/** A presigned URL lives at most 5 minutes; callers also bound it by the lease (spec §14). */
export const MAX_PRESIGN_TTL_MS = 5 * 60_000

export type PresignRequest = {
  bucket: PresignableBucket
  key: string
  /** Whole seconds are signed, rounded down; at least one. */
  ttlMs: number
} & (
  | { method: 'GET' }
  /**
   * Create-only: the URL signs `If-None-Match: *` and the exact Content-Length, so it can
   * neither overwrite an existing object nor store anything but `sizeBytes` bytes.
   */
  | { method: 'PUT'; sizeBytes: number }
)

/** A bearer capability: never logged, never handed to a sandbox. */
export interface PresignedRequest {
  method: 'GET' | 'PUT'
  url: string
  /** Signed headers the request must carry verbatim; Content-Length comes from the body. */
  headers: Record<string, string>
  expiresAt: Date
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
  /**
   * A scoped URL for one object, for a runner host and never a sandbox. Signing sends nothing
   * to S3. Browser uploads (M2) will widen presignableBuckets.
   */
  presign(request: PresignRequest): Promise<PresignedRequest>
}
