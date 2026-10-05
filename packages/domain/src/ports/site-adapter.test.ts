import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { PublishedContentGateway } from './published-content.ts'
import {
  siteAccessKinds,
  siteAccessPath,
  type SiteContentAdapter,
  type SiteHttpTransport,
} from './site-adapter.ts'

const siteId = '0196abcd-0000-7000-8000-00000000000f'

describe('siteAccessPath', () => {
  it('names the one Vault path of a site access of each kind', () => {
    expect(siteAccessKinds).toEqual(['ssh', 'ftp', 'wp', 'browser'])
    for (const kind of siteAccessKinds)
      expect(siteAccessPath(siteId, kind)).toBe(`kv/sites/${siteId}/${kind}`)
  })

  it('refuses anything that could leave the prefix of the site', () => {
    for (const id of [
      '',
      'site',
      `${siteId}/../x`,
      `${siteId}/wp`,
      '../subs',
      siteId.toUpperCase(),
    ])
      expect(() => siteAccessPath(id, 'wp')).toThrow('Invalid site access reference')
    for (const kind of ['', 'git', 'subscription', 'wp/../ssh', 'WP'])
      expect(() => siteAccessPath(siteId, kind as never)).toThrow('Invalid site access reference')
  })
})

describe('SiteContentAdapter', () => {
  it('lets the caller parse the secret and hand the gateway its site, origin and transport', async () => {
    // Checked by the type checker: an application needs nothing of the CMS to compose a gateway.
    const accessSchema = z.strictObject({ origin: z.url(), key: z.string().min(1) })
    const seen: unknown[] = []
    const adapter: SiteContentAdapter<z.infer<typeof accessSchema>> = {
      stack: 'static',
      accessKind: 'browser',
      accessSchema,
      createGateway(connection) {
        seen.push(connection.siteId, connection.origin, connection.access.key)
        return {} as PublishedContentGateway
      },
    }
    const neutral: SiteContentAdapter = adapter
    const transport: SiteHttpTransport = async () => ({ status: 200, body: new Uint8Array() })
    const access = neutral.accessSchema.safeParse({ origin: 'https://site.example.test', key: 'k' })
    expect(access.success).toBe(true)
    if (!access.success) return
    neutral.createGateway({
      siteId,
      origin: 'https://site.example.test',
      access: access.data,
      transport,
      allowLoopbackHttp: false,
    })
    expect(seen).toEqual([siteId, 'https://site.example.test', 'k'])
    expect(neutral.accessSchema.safeParse({ origin: 'https://site.example.test' }).success).toBe(
      false,
    )
  })
})
