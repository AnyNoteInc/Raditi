import type { BucketKind } from '@repo/domain'

/** Buckets the core role's S3 key may access (spec §14); /health checks only these. */
export const CORE_BUCKETS: readonly BucketKind[] = ['inbox', 'sessions', 'logs', 'artifacts']
