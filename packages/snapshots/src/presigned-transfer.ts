import { Buffer } from 'node:buffer'

import {
  badRequest,
  conflict,
  DomainError,
  isDomainError,
  type PresignedRequest,
} from '@repo/domain'

const TRANSFER_TIMEOUT_MS = 60_000

/**
 * Presigned S3 requests of a sandbox host (core's local executor or a runner). A URL is a
 * bearer capability: errors never carry it, its query string or the response body.
 */
export interface PresignedTransfer {
  /** The whole object, refused beyond `maxBytes`. */
  get(request: PresignedRequest, maxBytes: number): Promise<Uint8Array>
  /** A create-only PUT: an existing object is a CONFLICT and stays as it is. */
  put(request: PresignedRequest, body: Uint8Array): Promise<void>
}

const failed = () =>
  new DomainError('PRESIGNED_REQUEST_FAILED', 'Presigned storage request failed', 502)

export function fetchPresignedTransfer(options: { timeoutMs?: number } = {}): PresignedTransfer {
  const timeoutMs = options.timeoutMs ?? TRANSFER_TIMEOUT_MS
  const send = async (request: PresignedRequest, body?: Uint8Array): Promise<Response> => {
    try {
      return await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw failed()
    }
  }
  return {
    async get(request, maxBytes) {
      if (request.method !== 'GET') throw badRequest('Expected a presigned GET')
      const response = await send(request)
      const reader = response.body?.getReader()
      try {
        if (response.status !== 200 || !reader) throw failed()
        const chunks: Uint8Array[] = []
        let total = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maxBytes) throw badRequest('Stored object exceeds its size limit')
          chunks.push(value)
        }
        return Buffer.concat(chunks, total)
      } catch (error) {
        if (isDomainError(error)) throw error
        throw failed()
      } finally {
        await reader?.cancel().catch(() => {})
      }
    },

    async put(request, body) {
      if (request.method !== 'PUT' || request.headers['if-none-match'] !== '*')
        throw badRequest('Expected a create-only presigned PUT')
      const response = await send(request, body)
      await response.body?.cancel().catch(() => {})
      if (response.status === 412) throw conflict('Stored object already exists')
      if (!response.ok) throw failed()
    },
  }
}
