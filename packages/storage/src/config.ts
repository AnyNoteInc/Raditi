import type { BucketKind } from '@repo/domain'
import { z } from 'zod'

export interface StorageConfig {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** SeaweedFS needs path-style URLs; the Russian clouds accept both. */
  forcePathStyle: boolean
  buckets: Record<BucketKind, string>
}

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const bucketName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid S3 bucket name')

const bucket = (fallback: string) => z.preprocess(blankToUndefined, bucketName.default(fallback))

const envSchema = z.object({
  S3_ENDPOINT: z.preprocess(blankToUndefined, z.url({ protocol: /^https?$/ })),
  S3_REGION: z.preprocess(blankToUndefined, z.string().default('ru-central1')),
  S3_ACCESS_KEY_ID: z.preprocess(blankToUndefined, z.string()),
  S3_SECRET_ACCESS_KEY: z.preprocess(blankToUndefined, z.string()),
  S3_FORCE_PATH_STYLE: z.preprocess(blankToUndefined, z.stringbool().default(false)),
  S3_BUCKET_INBOX: bucket('raditi-inbox'),
  S3_BUCKET_SESSIONS: bucket('raditi-sessions'),
  S3_BUCKET_LOGS: bucket('raditi-logs'),
  S3_BUCKET_ARTIFACTS: bucket('raditi-artifacts'),
  S3_BUCKET_BACKUPS: bucket('raditi-backups'),
  S3_BUCKET_PLATFORM: bucket('raditi-platform'),
})

/**
 * Reads the S3 settings from an env-like object (usually process.env in the composition root).
 * The error lists variable names and reasons only, never values: two of them are credentials.
 */
export function storageConfigFromEnv(env: Record<string, string | undefined>): StorageConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new Error(`[@repo/storage] invalid S3 configuration: ${problems.join('; ')}`)
  }
  const e = parsed.data
  return {
    endpoint: e.S3_ENDPOINT,
    region: e.S3_REGION,
    accessKeyId: e.S3_ACCESS_KEY_ID,
    secretAccessKey: e.S3_SECRET_ACCESS_KEY,
    forcePathStyle: e.S3_FORCE_PATH_STYLE,
    buckets: {
      inbox: e.S3_BUCKET_INBOX,
      sessions: e.S3_BUCKET_SESSIONS,
      logs: e.S3_BUCKET_LOGS,
      artifacts: e.S3_BUCKET_ARTIFACTS,
      backups: e.S3_BUCKET_BACKUPS,
      platform: e.S3_BUCKET_PLATFORM,
    },
  }
}
