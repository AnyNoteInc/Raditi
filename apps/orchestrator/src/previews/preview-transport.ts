import { Buffer } from 'node:buffer'
import { request } from 'node:http'

import type { PreviewUpstream, SiteHttpTransport } from '@repo/domain'

// How core reaches a preview (docs/plan/53-chat-preview-release.md, Р24, R5a): plain http to the
// entry forwarder of the preview on PREVIEW_UPSTREAM_HOST, with `Host` of the preview's own name —
// the forwarder answers 421 to any other, so a port another preview took since is never served.
// The address of a request names a path only: its scheme, host and port are never followed.

export interface PreviewTarget {
  upstream: PreviewUpstream
  /** `preview_environments.hostname`. */
  hostname: string
}

/** A transport of site adapters bound to one preview. */
export function previewSiteTransport(target: PreviewTarget): SiteHttpTransport {
  return async (input) => {
    const url = new URL(input.url)
    return previewRequest(target, {
      method: input.method,
      path: `${url.pathname}${url.search}`,
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
    })
  }
}

export interface PreviewRequest {
  method: 'GET' | 'POST'
  /** A path with its query, one leading `/`. */
  path: string
  headers?: Readonly<Record<string, string>>
  body?: string
  timeoutMs: number
  maxResponseBytes: number
}

/** One request, no redirect followed; rejects on a network failure, the time or the size. */
export function previewRequest(
  target: PreviewTarget,
  input: PreviewRequest,
): Promise<{ status: number; body: Uint8Array }> {
  if (!input.path.startsWith('/') || input.path.startsWith('//'))
    return Promise.reject(new Error('A preview request names a path'))
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : Buffer.from(input.body, 'utf8')
    const headers: Record<string, string | number> = { ...input.headers }
    for (const name of Object.keys(headers))
      if (['host', 'content-length', 'connection'].includes(name.toLowerCase()))
        delete headers[name]
    const sent = request(
      {
        host: target.upstream.host,
        port: target.upstream.port,
        method: input.method,
        path: input.path,
        headers: {
          ...headers,
          host: target.hostname,
          connection: 'close',
          ...(body ? { 'content-length': body.byteLength } : {}),
        },
        timeout: input.timeoutMs,
        signal: AbortSignal.timeout(input.timeoutMs),
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength
          // Fixed text: a transport failure never carries what the preview answered.
          if (size > input.maxResponseBytes)
            response.destroy(new Error('Preview response exceeds its limit'))
          else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
        )
      },
    )
    sent.on('timeout', () => sent.destroy(new Error('Preview request timed out')))
    sent.on('error', reject)
    sent.end(body)
  })
}
