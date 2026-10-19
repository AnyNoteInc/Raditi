import { siteConnectionLimits } from '@repo/domain'

/**
 * The caller's own sink failed while a file streamed into it: its error goes back to the caller as it
 * was thrown, never translated into a reason of the connection.
 */
export class SinkFailure extends Error {
  override readonly cause: unknown

  constructor(cause: unknown) {
    super('File sink failed')
    this.name = 'SinkFailure'
    this.cause = cause
  }
}

/** The secret as Vault will store it stays under secretBytes (the KV adapter refuses 64 KiB requests). */
export function secretFits(secret: Record<string, string>): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(secret)).byteLength <= siteConnectionLimits.secretBytes
  )
}

/** Non-empty values, each once, in their first order. */
export function uniqueValues(values: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === 'string' && value !== ''),
    ),
  ]
}
