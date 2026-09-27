import { envVar, parseEnv, type BucketKind, type Env } from '@repo/domain'
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

const bucketName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid S3 bucket name')

const bucket = (fallback: string) => envVar(bucketName.default(fallback))

const envSchema = z.object({
  S3_ENDPOINT: envVar(z.url({ protocol: /^https?$/ })),
  S3_REGION: envVar(z.string().default('ru-central1')),
  S3_ACCESS_KEY_ID: envVar(z.string()),
  S3_SECRET_ACCESS_KEY: envVar(z.string()),
  S3_FORCE_PATH_STYLE: envVar(z.stringbool().default(false)),
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
export function storageConfigFromEnv(env: Env): StorageConfig {
  const e = parseEnv('storage', envSchema, env)
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
