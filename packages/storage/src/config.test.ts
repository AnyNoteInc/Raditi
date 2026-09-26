import { describe, expect, it } from 'vitest'

import { storageConfigFromEnv } from './config.ts'

const base = {
  S3_ENDPOINT: 'http://localhost:8333',
  S3_ACCESS_KEY_ID: 'raditi',
  S3_SECRET_ACCESS_KEY: 'super-secret-value',
}

describe('storageConfigFromEnv', () => {
  it('applies defaults for region, path style and raditi-* buckets', () => {
    expect(storageConfigFromEnv(base)).toEqual({
      endpoint: 'http://localhost:8333',
      region: 'ru-central1',
      accessKeyId: 'raditi',
      secretAccessKey: 'super-secret-value',
      forcePathStyle: false,
      buckets: {
        inbox: 'raditi-inbox',
        sessions: 'raditi-sessions',
        logs: 'raditi-logs',
        artifacts: 'raditi-artifacts',
        backups: 'raditi-backups',
        platform: 'raditi-platform',
      },
    })
  })

  it('treats blank values as unset, as in a copied .env.example', () => {
    const config = storageConfigFromEnv({
      ...base,
      S3_REGION: '',
      S3_FORCE_PATH_STYLE: ' ',
      S3_BUCKET_LOGS: '',
    })
    expect(config.region).toBe('ru-central1')
    expect(config.forcePathStyle).toBe(false)
    expect(config.buckets.logs).toBe('raditi-logs')
  })

  it('reads overrides', () => {
    const config = storageConfigFromEnv({
      ...base,
      S3_REGION: 'ru-moscow-1',
      S3_FORCE_PATH_STYLE: 'true',
      S3_BUCKET_BACKUPS: 'prod-raditi-backups',
    })
    expect(config.region).toBe('ru-moscow-1')
    expect(config.forcePathStyle).toBe(true)
    expect(config.buckets.backups).toBe('prod-raditi-backups')
  })

  it('accepts 1/0 for S3_FORCE_PATH_STYLE', () => {
    expect(storageConfigFromEnv({ ...base, S3_FORCE_PATH_STYLE: '1' }).forcePathStyle).toBe(true)
    expect(storageConfigFromEnv({ ...base, S3_FORCE_PATH_STYLE: '0' }).forcePathStyle).toBe(false)
  })

  it('rejects missing credentials and endpoint without echoing secret values', () => {
    let message = ''
    try {
      storageConfigFromEnv({ S3_SECRET_ACCESS_KEY: 'super-secret-value', S3_ENDPOINT: 'ftp://x' })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('S3_ENDPOINT')
    expect(message).toContain('S3_ACCESS_KEY_ID')
    expect(message).not.toContain('super-secret-value')
  })

  it('rejects invalid bucket names and path style flags', () => {
    expect(() => storageConfigFromEnv({ ...base, S3_BUCKET_INBOX: 'Raditi_Inbox' })).toThrow(
      /S3_BUCKET_INBOX/,
    )
    expect(() => storageConfigFromEnv({ ...base, S3_FORCE_PATH_STYLE: 'maybe' })).toThrow(
      /S3_FORCE_PATH_STYLE/,
    )
  })
})
