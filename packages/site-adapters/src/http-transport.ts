import type { SiteHttpTransport } from '@repo/domain'

/**
 * The plain transport of a site adapter: global fetch by the site's name, one request, no
 * redirect followed, bounded time and size. It does not look at the address the name resolves
 * to: a composition root that reaches customer sites injects a transport that does.
 */
export const fetchSiteTransport: SiteHttpTransport = async (request) => {
  const response = await fetch(new URL(request.url), {
    method: request.method,
    redirect: 'manual',
    signal: AbortSignal.timeout(request.timeoutMs),
    headers: { ...request.headers },
    ...(request.body === undefined ? {} : { body: request.body }),
  })
  if (!response.body) return { status: response.status, body: new Uint8Array() }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > request.maxResponseBytes) {
      await response.body.cancel().catch(() => {})
      // Fixed text: a transport failure never carries what the site answered.
      throw new Error('Site response exceeds its limit')
    }
    chunks.push(chunk)
  }
  return { status: response.status, body: Buffer.concat(chunks) }
}
