import type { SiteContentAdapter, SiteContentGateway } from '@repo/domain'

import { previewSiteTransport, type PreviewTarget } from './preview-transport.ts'

// The stack's plugin in a dialog's preview (docs/plan/53-chat-preview-release.md, Р15, Р22): core
// reaches it to build the preview, the mcp role to write what the agent changes there.

/**
 * The gateway of the stack's plugin in the preview. Every request goes to the upstream with the
 * preview's `Host` (previewSiteTransport), never to the origin named here: a plain-http preview
 * is named by a loopback origin only to pass the gateway's rule for http.
 */
export function previewContentGateway(input: {
  adapter: SiteContentAdapter
  previewId: string
  origin: string
  access: Record<string, string>
  target: PreviewTarget
}): SiteContentGateway {
  const https = new URL(input.origin).protocol === 'https:'
  const access = input.adapter.accessSchema.parse(input.access)
  return input.adapter.createGateway({
    // The plugin of the copy is bound to the preview (the copy policy, Р15).
    siteId: input.previewId,
    origin: https ? input.origin : 'http://localhost',
    access,
    transport: previewSiteTransport(input.target),
    allowLoopbackHttp: !https,
  })
}
