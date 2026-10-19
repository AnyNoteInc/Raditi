import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'

import {
  normalizeSiteHost,
  resolvePinnedAddress,
  tlsIdentity,
  type AppEnv,
  type HostLookup,
  type SiteHttpRequest,
  type SiteHttpResponse,
  type SiteHttpTransport,
} from '@repo/domain'

/**
 * A transport to a site that dials only an address the site-address rule allows (spec §12): the
 * name of the URL is resolved once per request (`resolvePinnedAddress`: in production only public
 * addresses), and the connection goes to that one literal — a name that changes its answer
 * between a check and the request is not followed. The TLS identity is the name. No redirect is
 * followed — a 3xx comes back with its `Location` (at most 2 KiB) for the caller to decide —, the
 * time and the size of the answer are bounded; a refused address or any failure rejects with
 * fixed text, never what the site or the resolver said.
 */
export function createPinnedSiteTransport(deps: {
  lookup: HostLookup
  appEnv: AppEnv
}): SiteHttpTransport {
  return async (request: SiteHttpRequest): Promise<SiteHttpResponse> => {
    const url = new URL(request.url)
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('Site request refused')
    if (url.username || url.password) throw new Error('Site request refused')
    const host = normalizeSiteHost(url.hostname)
    if (host === null) throw new Error('Site request refused')
    const signal = AbortSignal.timeout(request.timeoutMs)
    const pinned = await resolvePinnedAddress(deps, host, signal)
    if (!pinned.ok) throw new Error('Site address refused')
    const secure = url.protocol === 'https:'
    const send = secure ? httpsRequest : httpRequest
    const body = request.body === undefined ? undefined : Buffer.from(request.body, 'utf8')
    return new Promise<SiteHttpResponse>((resolve, reject) => {
      let settled = false
      const fail = () => {
        if (settled) return
        settled = true
        reject(new Error('Site request failed'))
      }
      const outgoing = send(
        {
          host: pinned.address.address,
          family: pinned.address.family,
          port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers: {
            ...request.headers,
            host: url.host,
            ...(body === undefined ? {} : { 'content-length': String(body.byteLength) }),
          },
          signal,
          agent: false,
          ...(secure ? { ...tlsIdentity(pinned.address), rejectUnauthorized: true } : {}),
        },
        (response: IncomingMessage) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > request.maxResponseBytes) {
              response.destroy()
              fail()
              return
            }
            chunks.push(chunk)
          })
          response.on('error', fail)
          response.on('end', () => {
            if (settled) return
            settled = true
            const status = response.statusCode ?? 0
            const location = response.headers.location
            resolve({
              status,
              body: Buffer.concat(chunks, size),
              ...(status >= 300 && status < 400 && location && location.length <= 2048
                ? { location }
                : {}),
            })
          })
        },
      )
      outgoing.on('error', fail)
      outgoing.end(body)
    })
  }
}
